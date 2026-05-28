# YMS Manager — YUMiLab Multi-Color System for Klipper
#
# Lightweight Klipper extras module that exposes printer.yms_manager
# for Mainsail/KlipperScreen visual rendering. Auto-detects YMS slots
# from printer.cfg (extruder_stepper + filament sensors).
#
# Zero motor control — existing T macros handle SYNC_EXTRUDER_MOTION.
# This module only observes state and exposes it for UI rendering.
#
# Mapping format in variables.cfg:
#   yms_mapping = "T0:E0,T1:E1,T2:E2,T3:E3,T4:E4,T5:E5,T6:E6"
#   Meaning: T0 routes to extruder0 (YMS-1), T1 to extruder1 (YMS-2), etc.
#
# Copyright (C) 2026 YUMi-Lab
# Licensed under GNU GPLv3
#
import logging

# Filament path positions
FPATH_NONE     = 'none'
FPATH_GATE     = 'gate'       # Detected at motion sensor (filament inserted)
FPATH_BOWDEN   = 'bowden'     # In PTFE tube (standby position above hotend)
FPATH_TOOLHEAD = 'toolhead'   # Detected by toolhead switch
FPATH_NOZZLE   = 'nozzle'    # Actively extruding

# Slot status codes
STATUS_UNKNOWN  = -1
STATUS_EMPTY    =  0
STATUS_DETECTED =  1
STATUS_BLOCKED  =  2  # Smart motion sensor blockage detection

# Default rainbow palette (up to 12 slots)
DEFAULT_COLORS = [
    'FF0000', 'FF8800', 'FFFF00', '00FF00', '0088FF',
    '8800FF', 'FF00FF', 'FF4444', '44FF44', '4444FF',
    'FFAA00', '00FFAA',
]


class YmsManager:
    """YMS Manager — auto-detects multi-color slots and exposes state for UI."""

    def __init__(self, config):
        self.config = config
        self.printer = config.get_printer()
        self.reactor = self.printer.get_reactor()
        self.gcode = self.printer.lookup_object('gcode')

        # State
        self.enabled = False
        self.num_slots = 0
        self.active_tool = -1
        self.active_slot = -1
        self.is_in_print = False
        self.print_state = 'standby'

        # Per-slot data
        self.slot_color = []
        self.slot_name = []
        self.slot_material = []
        self.slot_temperature = []
        self.slot_status = []
        self.slot_sensor_type = []
        self.slot_sensor_name = []

        # Mapping T→E (parsed from "T0:E0,T1:E1,...")
        self.tool_to_slot_map = []
        self.mapping_raw = ''

        # Toolhead switch sensor
        self.toolhead_sensor = False
        self.toolhead_sensor_name = ''
        self.toolhead_detected = False
        self._toolhead_obj = None

        # Cutter
        self.cutter_available = False
        self.cutter_enabled = False

        # Internal refs
        self._sensors = {}
        self._save_variables = None
        self._print_stats = None
        self._timer = None

        # Register events
        self.printer.register_event_handler('klippy:ready', self._handle_ready)
        self.printer.register_event_handler('klippy:disconnect', self._handle_disconnect)

        # Register gcode commands
        self.gcode.register_command(
            'YMS_MAP', self.cmd_YMS_MAP,
            desc='View or modify YMS slot attributes and mapping')
        self.gcode.register_command(
            'YMS_STATUS', self.cmd_YMS_STATUS,
            desc='Display YMS system status')
        self.gcode.register_command(
            'YMS_CHECK_SLOTS', self.cmd_YMS_CHECK_SLOTS,
            desc='Force-read all filament sensors')
        self.gcode.register_command(
            'YMS_CUTTER', self.cmd_YMS_CUTTER,
            desc='Enable or disable the filament cutter')

    # ── Startup ─────────────────────────────────────────────────────────

    def _handle_ready(self):
        """Auto-detect YMS slots from printer.cfg at startup."""
        self._save_variables = self.printer.lookup_object('save_variables', None)
        self._print_stats = self.printer.lookup_object('print_stats', None)

        # 1. Detect extruder_stepper sections
        self.num_slots = self._detect_steppers()
        if self.num_slots == 0:
            logging.info("YMS Manager: no extruder_stepper found, disabled")
            return

        self.enabled = True

        # 2. Detect filament sensors
        self._sensors = self._detect_sensors()

        # 3. Detect toolhead switch
        self._detect_toolhead()

        # 4. Detect cutter
        self._detect_cutter()

        # 5. Init slot arrays with defaults
        self._init_slots()

        # 6. Load persisted data (colors, mapping, cutter state)
        self._load_saved()

        # 7. Start 1s polling timer
        self._timer = self.reactor.register_timer(
            self._poll, self.reactor.NOW)

        sensor_count = sum(1 for s in self._sensors.values() if s)
        logging.info(
            "YMS Manager: %d slots, %d sensors, toolhead=%s, cutter=%s",
            self.num_slots, sensor_count,
            self.toolhead_sensor_name or 'none',
            'yes' if self.cutter_available else 'no')

    def _handle_disconnect(self):
        if self._timer:
            self.reactor.unregister_timer(self._timer)
            self._timer = None

    # ── Auto-detection ──────────────────────────────────────────────────

    def _detect_steppers(self):
        """Count [extruder_stepper extruder0..11] in printer.cfg."""
        configfile = self.printer.lookup_object('configfile')
        settings = configfile.get_status(0).get('settings', {})
        count = 0
        for i in range(12):
            if 'extruder_stepper extruder%d' % i in settings:
                count += 1
            else:
                break
        return count

    def _detect_sensors(self):
        """Find filament sensors per slot (YMS-1, YMS-2, ...)."""
        sensors = {}
        for i in range(self.num_slots):
            name = 'YMS-%d' % (i + 1)
            # Try smart motion sensor first
            obj = self.printer.lookup_object(
                'filament_yumi_smart_motion_sensor %s' % name, None)
            if obj:
                sensors[i] = {'type': 'smart_motion', 'name': name, 'obj': obj}
                continue
            # Try standard motion sensor
            obj = self.printer.lookup_object(
                'filament_motion_sensor %s' % name, None)
            if obj:
                sensors[i] = {'type': 'motion', 'name': name, 'obj': obj}
                continue
            sensors[i] = None
        return sensors

    def _detect_toolhead(self):
        """Find a filament_switch_sensor for toolhead detection."""
        for name in ['filament_sensor', 'toolhead_sensor', 'toolhead']:
            obj = self.printer.lookup_object(
                'filament_switch_sensor %s' % name, None)
            if obj:
                self.toolhead_sensor = True
                self.toolhead_sensor_name = name
                self._toolhead_obj = obj
                return

    def _detect_cutter(self):
        """Detect cutter availability (servo or dedicated macro)."""
        # Check for cutter servo
        obj = self.printer.lookup_object('servo cutter', None)
        if obj:
            self.cutter_available = True
            return
        # Check for cutter macro
        obj = self.printer.lookup_object('gcode_macro CUT_FILAMENT', None)
        if not obj:
            obj = self.printer.lookup_object('gcode_macro _MMU_CUT_TIP', None)
        if not obj:
            obj = self.printer.lookup_object('gcode_macro CUTTER', None)
        if obj:
            self.cutter_available = True

    # ── Slot initialization ─────────────────────────────────────────────

    def _init_slots(self):
        """Set default values for all slot arrays."""
        n = self.num_slots
        self.slot_color = [DEFAULT_COLORS[i % len(DEFAULT_COLORS)] for i in range(n)]
        self.slot_name = ['YMS-%d' % (i + 1) for i in range(n)]
        self.slot_material = ['PLA'] * n
        self.slot_temperature = [210] * n
        self.slot_status = [STATUS_UNKNOWN] * n
        self.tool_to_slot_map = list(range(n))
        self.mapping_raw = ','.join('T%d:E%d' % (i, i) for i in range(n))

        self.slot_sensor_type = []
        self.slot_sensor_name = []
        for i in range(n):
            s = self._sensors.get(i)
            self.slot_sensor_type.append(s['type'] if s else 'none')
            self.slot_sensor_name.append(s['name'] if s else '')

    def _load_saved(self):
        """Load persisted data from variables.cfg."""
        if not self._save_variables:
            return
        v = self._save_variables.allVariables
        n = self.num_slots

        # Mapping
        raw = v.get('yms_mapping', '')
        if raw:
            self.mapping_raw = raw
            self.tool_to_slot_map = self._parse_mapping(raw, n)

        # Slot attributes
        saved = v.get('yms_slot_color', None)
        if saved and len(saved) == n:
            self.slot_color = list(saved)
        saved = v.get('yms_slot_name', None)
        if saved and len(saved) == n:
            self.slot_name = list(saved)
        saved = v.get('yms_slot_material', None)
        if saved and len(saved) == n:
            self.slot_material = list(saved)
        saved = v.get('yms_slot_temperature', None)
        if saved and len(saved) == n:
            self.slot_temperature = list(saved)

        # Cutter
        self.cutter_enabled = bool(v.get('yms_cutter_enabled', False))

    def _parse_mapping(self, raw, num_slots):
        """Parse 'T0:E0,T1:E1,...' into [0, 1, 2, ...] slot index list."""
        mapping = list(range(num_slots))
        try:
            for pair in raw.split(','):
                pair = pair.strip()
                if ':' not in pair:
                    continue
                t_part, e_part = pair.split(':', 1)
                t_idx = int(t_part.strip().lstrip('Tt'))
                e_idx = int(e_part.strip().lstrip('Ee'))
                if 0 <= t_idx < num_slots and 0 <= e_idx < num_slots:
                    mapping[t_idx] = e_idx
        except (ValueError, IndexError):
            logging.warning("YMS Manager: failed to parse mapping '%s'", raw)
        return mapping

    def _save_data(self):
        """Persist slot data to variables.cfg."""
        if not self._save_variables:
            return
        cmds = [
            'SAVE_VARIABLE VARIABLE=yms_mapping VALUE=\'"%s"\'' % self.mapping_raw,
            'SAVE_VARIABLE VARIABLE=yms_slot_color VALUE=\'%s\'' % self.slot_color,
            'SAVE_VARIABLE VARIABLE=yms_slot_name VALUE=\'%s\'' % self.slot_name,
            'SAVE_VARIABLE VARIABLE=yms_slot_material VALUE=\'%s\'' % self.slot_material,
            'SAVE_VARIABLE VARIABLE=yms_slot_temperature VALUE=\'%s\'' % self.slot_temperature,
            'SAVE_VARIABLE VARIABLE=yms_cutter_enabled VALUE=%s' % (
                'True' if self.cutter_enabled else 'False'),
        ]
        for cmd in cmds:
            self.gcode.run_script_from_command(cmd)

    # ── Polling (1s timer) ──────────────────────────────────────────────

    def _poll(self, eventtime):
        """Read state from save_variables and sensors every second."""
        if not self.enabled:
            return eventtime + 1.

        # Active tool from save_variables
        if self._save_variables:
            v = self._save_variables.allVariables
            raw = v.get('active_tool', 0)
            if isinstance(raw, (int, float)):
                val = int(raw)
                # Convention: 0=none, 1=YMS-1, 2=YMS-2...
                self.active_tool = val - 1 if val > 0 else -1
            else:
                self.active_tool = -1

            # Slot from mapping
            if 0 <= self.active_tool < self.num_slots:
                self.active_slot = self.tool_to_slot_map[self.active_tool]
            else:
                self.active_slot = -1

            # Print state from save_variables
            self.is_in_print = bool(v.get('printing_start', False))

            # Per-slot sensor from save_variables
            for i in range(self.num_slots):
                val = v.get('yms%d_sensor' % (i + 1), None)
                if val is True:
                    self.slot_status[i] = STATUS_DETECTED
                elif val is False:
                    self.slot_status[i] = STATUS_EMPTY

        # Print stats
        if self._print_stats:
            ps = self._print_stats.get_status(eventtime)
            self.print_state = ps.get('state', 'standby')
            if self.print_state == 'printing':
                self.is_in_print = True

        # Toolhead switch
        if self._toolhead_obj:
            try:
                ts = self._toolhead_obj.get_status(eventtime)
                self.toolhead_detected = ts.get('filament_detected', False)
            except Exception:
                pass

        return eventtime + 1.

    # ── Filament path logic ─────────────────────────────────────────────

    def _filament_path(self):
        if self.active_slot < 0:
            return FPATH_NONE
        slot_ok = (0 <= self.active_slot < self.num_slots and
                   self.slot_status[self.active_slot] == STATUS_DETECTED)
        if self.toolhead_detected:
            return FPATH_NOZZLE if self.print_state == 'printing' else FPATH_TOOLHEAD
        if slot_ok:
            return FPATH_BOWDEN
        return FPATH_GATE if self.active_slot >= 0 else FPATH_NONE

    def _filament_state(self):
        if self.toolhead_detected:
            return 'Loaded'
        if (self.active_slot >= 0 and self.active_slot < self.num_slots and
                self.slot_status[self.active_slot] == STATUS_DETECTED):
            return 'Standby'
        return 'Unloaded'

    # ── Status exposure ─────────────────────────────────────────────────

    def get_status(self, eventtime):
        """Expose printer.yms_manager to Moonraker/Mainsail."""
        return {
            'enabled':                  self.enabled,
            'num_slots':                self.num_slots,
            'tool':                     self.active_tool,
            'slot':                     self.active_slot,
            'slot_color':               list(self.slot_color),
            'slot_name':                list(self.slot_name),
            'slot_material':            list(self.slot_material),
            'slot_temperature':         list(self.slot_temperature),
            'slot_status':              list(self.slot_status),
            'slot_sensor_type':         list(self.slot_sensor_type),
            'slot_sensor_name':         list(self.slot_sensor_name),
            'toolhead_sensor':          self.toolhead_sensor,
            'toolhead_sensor_name':     self.toolhead_sensor_name,
            'toolhead_filament_detected': self.toolhead_detected,
            'cutter_available':         self.cutter_available,
            'cutter_enabled':           self.cutter_enabled,
            'tool_to_slot_map':         list(self.tool_to_slot_map),
            'mapping':                  self.mapping_raw,
            'filament':                 self._filament_state(),
            'filament_path':            self._filament_path(),
            'is_in_print':              self.is_in_print,
            'print_state':              self.print_state,
        }

    # ── Gcode commands ──────────────────────────────────────────────────

    cmd_YMS_MAP_help = "View or modify YMS slot attributes and mapping"
    def cmd_YMS_MAP(self, gcmd):
        """YMS_MAP [SLOT=N COLOR=hex MATERIAL=str NAME=str TEMP=int] [MAPPING=T0:E0,...]"""
        # Handle mapping update
        mapping = gcmd.get('MAPPING', None)
        if mapping:
            self.mapping_raw = mapping
            self.tool_to_slot_map = self._parse_mapping(mapping, self.num_slots)
            self._save_data()
            gcmd.respond_info("YMS mapping updated: %s" % mapping)
            return

        # Handle single slot update
        slot = gcmd.get_int('SLOT', -1)
        if slot < 0:
            self._display_status(gcmd)
            return
        if slot >= self.num_slots:
            gcmd.respond_info("Error: SLOT=%d out of range (0-%d)" %
                              (slot, self.num_slots - 1))
            return

        color = gcmd.get('COLOR', None)
        if color:
            self.slot_color[slot] = color.upper().replace('#', '')
        material = gcmd.get('MATERIAL', None)
        if material:
            self.slot_material[slot] = material
        name = gcmd.get('NAME', None)
        if name:
            self.slot_name[slot] = name
        temp = gcmd.get_int('TEMP', -1)
        if temp > 0:
            self.slot_temperature[slot] = temp

        self._save_data()
        gcmd.respond_info("Slot %d: %s #%s %s %d°C" % (
            slot, self.slot_name[slot], self.slot_color[slot],
            self.slot_material[slot], self.slot_temperature[slot]))

    cmd_YMS_STATUS_help = "Display YMS system status"
    def cmd_YMS_STATUS(self, gcmd):
        self._display_status(gcmd)

    cmd_YMS_CHECK_SLOTS_help = "Force-read all filament sensors"
    def cmd_YMS_CHECK_SLOTS(self, gcmd):
        if not self.enabled:
            gcmd.respond_info("YMS Manager: disabled (no slots)")
            return
        eventtime = self.reactor.monotonic()
        for i in range(self.num_slots):
            s = self._sensors.get(i)
            if s and s['obj']:
                try:
                    st = s['obj'].get_status(eventtime)
                    detected = st.get('filament_detected', False)
                    self.slot_status[i] = STATUS_DETECTED if detected else STATUS_EMPTY
                except Exception:
                    self.slot_status[i] = STATUS_UNKNOWN
        if self._toolhead_obj:
            try:
                ts = self._toolhead_obj.get_status(eventtime)
                self.toolhead_detected = ts.get('filament_detected', False)
            except Exception:
                pass
        self._display_status(gcmd)

    cmd_YMS_CUTTER_help = "Enable or disable the filament cutter"
    def cmd_YMS_CUTTER(self, gcmd):
        """YMS_CUTTER [ENABLE=0|1]"""
        if not self.cutter_available:
            gcmd.respond_info("YMS: no cutter detected")
            return
        enable = gcmd.get_int('ENABLE', -1)
        if enable < 0:
            gcmd.respond_info("YMS cutter: %s" %
                              ('enabled' if self.cutter_enabled else 'disabled'))
            return
        self.cutter_enabled = bool(enable)
        self._save_data()
        gcmd.respond_info("YMS cutter %s" %
                          ('enabled' if self.cutter_enabled else 'disabled'))

    def _display_status(self, gcmd):
        """Print formatted status table."""
        status_sym = {
            STATUS_UNKNOWN: '?', STATUS_EMPTY: '-',
            STATUS_DETECTED: '*', STATUS_BLOCKED: '!',
        }
        lines = [
            "YMS Multi-Color — %d slots" % self.num_slots,
            "Mapping: %s" % self.mapping_raw,
            "-" * 65,
        ]
        for i in range(self.num_slots):
            s = self._sensors.get(i)
            stype = s['type'][:6] if s else 'none'
            sym = status_sym.get(self.slot_status[i], '?')
            active = ' <<' if i == self.active_slot else ''
            lines.append(
                " [%s] %-6s #%s %-5s %3d°C %s %s%s" % (
                    sym, self.slot_name[i], self.slot_color[i],
                    self.slot_material[i], self.slot_temperature[i],
                    stype, 'T%d->E%d' % (i, self.tool_to_slot_map[i]),
                    active))
        lines.append("-" * 65)
        th = 'detected' if self.toolhead_detected else 'empty'
        lines.append(" Toolhead: %s (%s)" % (th, self.toolhead_sensor_name or 'none'))
        if self.cutter_available:
            lines.append(" Cutter: %s" % ('ON' if self.cutter_enabled else 'OFF'))
        lines.append(" Filament: %s (%s)" % (
            self._filament_state(), self._filament_path()))
        lines.append(" Print: %s" % self.print_state)
        gcmd.respond_info("\n".join(lines))


def load_config(config):
    return YmsManager(config)
