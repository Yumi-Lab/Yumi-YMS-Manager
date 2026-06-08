#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# YMS Manager — YUMiLab Multi-Color System
# Installer / Updater
#
# Links yms_manager.py into Klipper extras and configures Moonraker
# update manager for OTA updates.
#
# Usage:
#   ./install.sh          Install / Update
#   ./install.sh -d       Uninstall
# ═══════════════════════════════════════════════════════════════════════
set -e

SRCDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KLIPPER_HOME="${KLIPPER_HOME:-${HOME}/klipper}"
CONFIG_HOME="${CONFIG_HOME:-${HOME}/printer_data/config}"
MOONRAKER_CONF="${CONFIG_HOME}/moonraker.conf"
PRINTER_CFG="${CONFIG_HOME}/printer.cfg"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[YMS]${NC} $1"; }
warn()  { echo -e "${YELLOW}[YMS]${NC} $1"; }
error() { echo -e "${RED}[YMS]${NC} $1"; }

# ── Uninstall ──────────────────────────────────────────────────────────

uninstall() {
    info "Uninstalling YMS Manager..."

    # Remove Klipper symlink
    if [ -L "${KLIPPER_HOME}/klippy/extras/yms_manager.py" ]; then
        rm -f "${KLIPPER_HOME}/klippy/extras/yms_manager.py"
        info "Removed Klipper module symlink"
    fi

    # Remove Moonraker update manager entry
    if [ -f "${MOONRAKER_CONF}" ]; then
        sed -i '/\[update_manager Yumi-YMS-Manager\]/,/^$/d' "${MOONRAKER_CONF}"
        info "Removed update manager from moonraker.conf"
    fi

    # Remove Mainsail injection
    MAINSAIL_DIR="${MAINSAIL_DIR:-${HOME}/mainsail}"
    rm -f "${MAINSAIL_DIR}/yms_panel.html" "${MAINSAIL_DIR}/yms_inject.js"
    if [ -f "${MAINSAIL_DIR}/index.html" ]; then
        sed -i '/yms_inject.js/d' "${MAINSAIL_DIR}/index.html"
        info "Cleaned Mainsail injection"
    fi

    info "Uninstall complete."
    info "Manually remove [yms_manager] from printer.cfg if present."
    exit 0
}

# ── Parse args ─────────────────────────────────────────────────────────

if [ "$1" = "-d" ]; then
    uninstall
fi

# ── Verify ─────────────────────────────────────────────────────────────

if [ ! -d "${KLIPPER_HOME}/klippy/extras" ]; then
    error "Klipper not found at ${KLIPPER_HOME}"
    exit 1
fi

# ── Install ────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  YMS Manager — YUMiLab Multi-Color System${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""

# 1. Link module into Klipper extras
info "Linking yms_manager.py to Klipper extras..."
ln -sf "${SRCDIR}/yms_manager.py" "${KLIPPER_HOME}/klippy/extras/yms_manager.py"
info "  → ${KLIPPER_HOME}/klippy/extras/yms_manager.py"

# 2. Do NOT inject [yms_manager] into printer.cfg.
# The section belongs to YMS-equipped machines only; their device-specific
# printer.cfg (shipped by yumi-config) already declares it at the top. This
# installer runs on EVERY pad (YUMI_SYNC bootstrap-clones the repo), so adding
# the section here would pollute non-YMS pads with a useless config block.
#
# Self-heal: an older install.sh appended "[yms_manager]" with >> on non-YMS
# pads, so it landed AFTER the trailing #*# SAVE_CONFIG block. Remove it in that
# broken case only. On real YMS machines the section sits at the top (before the
# autosave block) and is left untouched.
if [ -f "${PRINTER_CFG}" ] && grep -q '^\[yms_manager\]' "${PRINTER_CFG}"; then
    yms_line="$(grep -n '^\[yms_manager\]' "${PRINTER_CFG}" | head -n1 | cut -d: -f1)"
    save_line="$(grep -n 'SAVE_CONFIG' "${PRINTER_CFG}" | head -n1 | cut -d: -f1)"
    if [ -n "${save_line}" ] && [ "${yms_line}" -gt "${save_line}" ]; then
        sed -i '/^\[yms_manager\]$/d' "${PRINTER_CFG}"
        chown pi:pi "${PRINTER_CFG}"
        info "Removed stray [yms_manager] appended after SAVE_CONFIG (non-YMS pad)"
    else
        info "[yms_manager] present and correctly placed — left untouched"
    fi
fi

# 3. Add Moonraker update manager for OTA
if [ -f "${MOONRAKER_CONF}" ]; then
    if ! grep -q 'update_manager Yumi-YMS-Manager' "${MOONRAKER_CONF}"; then
        cat >> "${MOONRAKER_CONF}" << 'UPDMGR'

[update_manager Yumi-YMS-Manager]
type: git_repo
path: ~/Yumi-YMS-Manager
origin: https://github.com/Yumi-Lab/Yumi-YMS-Manager.git
primary_branch: main
managed_services: klipper
install_script: install.sh
UPDMGR
        info "Added OTA update manager to moonraker.conf"
    else
        info "Update manager already in moonraker.conf"
    fi
fi

# 4. Inject YMS panel into Mainsail
MAINSAIL_DIR="${MAINSAIL_DIR:-${HOME}/mainsail}"
if [ -d "${MAINSAIL_DIR}" ]; then
    info "Injecting YMS panel into Mainsail..."

    # Symlink panel + inject script into Mainsail static directory
    ln -sf "${SRCDIR}/yms_panel.html" "${MAINSAIL_DIR}/yms_panel.html"
    ln -sf "${SRCDIR}/yms_inject.js" "${MAINSAIL_DIR}/yms_inject.js"
    info "  Linked yms_panel.html + yms_inject.js"

    # Patch index.html to load our inject script (idempotent)
    INDEX="${MAINSAIL_DIR}/index.html"
    if [ -f "${INDEX}" ]; then
        if ! grep -q 'yms_inject.js' "${INDEX}"; then
            sed -i 's|</body>|    <script src="/yms_inject.js"></script>\n</body>|' "${INDEX}"
            info "  Patched index.html with <script> tag"
        else
            info "  index.html already patched"
        fi
    fi
else
    warn "Mainsail not found at ${MAINSAIL_DIR}, skipping panel injection"
fi

# ── Done ───────────────────────────────────────────────────────────────

echo ""
info "Installation complete!"
info "Restart Klipper to activate: sudo systemctl restart klipper"
info "Refresh Mainsail to see YMS panel in sidebar"
echo ""
