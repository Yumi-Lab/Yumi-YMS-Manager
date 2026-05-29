/**
 * YMS Multi-Color Panel — Mainsail Injection Script
 *
 * When "YMS Multi-Color" is clicked in the sidebar:
 *   - Hides ALL Mainsail content (main, right drawer, etc.)
 *   - Shows our own div with the full YMS SVG panel
 * When any other sidebar item is clicked:
 *   - Restores Mainsail, hides our div
 *
 * No iframe — direct div injection + SVG rendering + Moonraker API polling.
 */

(function() {
  'use strict';

  const MAX_WAIT = 30000;
  const API = `http://${window.location.hostname}:7125`;
  let ymsActive = false;
  let ymsDiv = null;
  let ymsNavItem = null;
  let pollTimer = null;
  let D = null, eT = 0;

  // ── SVG icon ─────────────────────────────────────────────────────────
  const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="width:24px;height:24px;fill:currentColor">
    <path d="M12,2C6.47,2 2,6.47 2,12C2,17.53 6.47,22 12,22A2,2 0 0,0 14,20C14,19.45 13.78,18.95 13.41,18.59C13.06,18.24 12.86,17.75 12.86,17.25A2,2 0 0,1 14.86,15.25H16.25C19.45,15.25 22,12.7 22,9.5C22,5.36 17.52,2 12,2M6.5,13A1.5,1.5 0 0,1 5,11.5A1.5,1.5 0 0,1 6.5,10A1.5,1.5 0 0,1 8,11.5A1.5,1.5 0 0,1 6.5,13M9.5,8A1.5,1.5 0 0,1 8,6.5A1.5,1.5 0 0,1 9.5,5A1.5,1.5 0 0,1 11,6.5A1.5,1.5 0 0,1 9.5,8M14.5,8A1.5,1.5 0 0,1 13,6.5A1.5,1.5 0 0,1 14.5,5A1.5,1.5 0 0,1 16,6.5A1.5,1.5 0 0,1 14.5,8M17.5,13A1.5,1.5 0 0,1 16,11.5A1.5,1.5 0 0,1 17.5,10A1.5,1.5 0 0,1 19,11.5A1.5,1.5 0 0,1 17.5,13Z"/>
  </svg>`;

  // ── Helpers ──────────────────────────────────────────────────────────
  function waitFor(sel, timeout) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function check() {
        const el = document.querySelector(sel);
        if (el) return resolve(el);
        if (Date.now() - t0 > timeout) return reject('timeout');
        requestAnimationFrame(check);
      })();
    });
  }

  const NS = 'http://www.w3.org/2000/svg';
  function sv(tag, a, txt) {
    const e = document.createElementNS(NS, tag);
    if (a) for (const [k,v] of Object.entries(a)) e.setAttribute(k, v);
    if (txt !== undefined) e.textContent = txt;
    return e;
  }

  function msC(s, act) {
    if (s===2) return 'ms-blocked';
    if (s===1) return 'ms-detected'+(act?' pulse':'');
    if (s===0) return 'ms-empty';
    return 'ms-unknown';
  }

  // ── Styles ──────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('yms-styles')) return;
    const style = document.createElement('style');
    style.id = 'yms-styles';
    style.textContent = `
      #yms-root { display:none; position:fixed; top:48px; left:256px; right:0; bottom:0; z-index:100; background:rgb(18,18,18); overflow-y:auto; padding:16px; font-family:Roboto,sans-serif; color:rgba(255,255,255,.87); }
      #yms-root.yms-show { display:block; }
      #yms-root .yms-hdr { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
      #yms-root .yms-hdr h2 { font-size:16px; font-weight:600; color:#fff; margin:0; }
      #yms-root .yms-badge { font-size:11px; padding:3px 10px; border-radius:10px; font-weight:500; }
      .yms-b-ready { background:#1b5e20; color:#4caf50; }
      .yms-b-print { background:#e65100; color:#fb8c00; }
      .yms-b-off { background:#424242; color:rgba(255,255,255,.5); }
      #yms-root .yms-svg { width:100%; max-width:900px; margin:0 auto; display:block; }
      .slot-card { fill:rgb(30,30,30); stroke:rgba(255,255,255,.12); stroke-width:1; }
      .slot-card-act { fill:rgb(30,30,30); stroke:#2196f3; stroke-width:2; }
      .ms-detected { fill:#4caf50; } .ms-empty { fill:rgba(255,255,255,.12); } .ms-unknown { fill:#fb8c00; } .ms-blocked { fill:#ff5252; }
      .ms-lbl { fill:rgba(255,255,255,.7); font-size:6px; font-family:Roboto,sans-serif; text-anchor:middle; dominant-baseline:central; }
      .gear-on { fill:#4caf50; } .gear-off { fill:rgba(255,255,255,.08); }
      .gear-ico { fill:rgba(255,255,255,.5); font-size:9px; text-anchor:middle; dominant-baseline:central; }
      .tube { fill:none; stroke-width:2.5; stroke-linecap:round; }
      .tube-idle { stroke:rgba(255,255,255,.06); } .tube-live { stroke-dasharray:8 4; }
      .flow { animation:yfl .7s linear infinite; } @keyframes yfl { to { stroke-dashoffset:-12; } }
      .fp { stroke:#fff; stroke-width:1.5; }
      .fp-lbl { fill:#8899bb; font-size:6px; font-family:system-ui; text-anchor:middle; }
      .hot-box { fill:rgb(30,30,30); stroke:rgba(255,255,255,.12); stroke-width:1.5; }
      .hot-lbl { fill:rgba(255,255,255,.6); font-size:10px; font-family:Roboto,sans-serif; text-anchor:middle; dominant-baseline:central; }
      .ts-on { fill:#4caf50; stroke:#66BB6A; stroke-width:1.5; } .ts-off { fill:rgba(255,255,255,.12); stroke:rgba(255,255,255,.2); stroke-width:1.5; }
      .ts-lbl { fill:#fff; font-size:7px; font-family:Roboto,sans-serif; text-anchor:middle; dominant-baseline:central; }
      .cut-on { fill:#ff4081; stroke:#f50057; stroke-width:1.5; } .cut-off { fill:rgba(255,255,255,.08); stroke:rgba(255,255,255,.2); stroke-width:1; }
      .cut-ico { fill:#fff; font-size:11px; text-anchor:middle; dominant-baseline:central; pointer-events:none; }
      .noz { fill:#ff5252; }
      .noz-t { fill:#ff8a80; font-size:11px; font-family:Roboto,sans-serif; text-anchor:middle; font-weight:700; }
      .pulse { animation:ypu 1.4s ease-in-out infinite; } @keyframes ypu { 0%,100%{opacity:1;} 50%{opacity:.4;} }
      .slot-txt { fill:#fff; font-size:10px; font-weight:600; font-family:Roboto,sans-serif; text-anchor:middle; }
      .slot-sub { fill:rgba(255,255,255,.5); font-size:8px; font-family:Roboto,sans-serif; text-anchor:middle; }
      #yms-root .yms-ctrls { display:flex; gap:5px; flex-wrap:wrap; justify-content:center; margin-top:12px; max-width:900px; margin-left:auto; margin-right:auto; }
      #yms-root .yms-btn { background:rgb(30,30,30); border:1px solid rgba(255,255,255,.12); color:rgba(255,255,255,.7); padding:5px 12px; border-radius:4px; cursor:pointer; font-size:11px; font-family:Roboto,sans-serif; transition:all .15s; }
      #yms-root .yms-btn:hover { background:rgb(40,40,40); border-color:#2196f3; color:#fff; }
      #yms-root .yms-btn.active { background:rgb(20,40,20); border-color:#4caf50; color:#4caf50; }
      #yms-root .yms-btn-init { background:rgb(13,71,161); border-color:#2196f3; color:#90caf9; font-weight:700; font-size:12px; }
      #yms-root .yms-info { margin-top:10px; padding:6px 12px; background:rgb(30,30,30); border-radius:4px; font-size:10px; font-family:'Roboto Mono',monospace; color:rgba(255,255,255,.4); text-align:center; max-width:900px; margin-left:auto; margin-right:auto; }
      #yms-root .yms-info span { color:#2196f3; }
    `;
    document.head.appendChild(style);
  }

  // ── Create the YMS root div ──────────────────────────────────────────
  function createRoot() {
    injectStyles();
    const root = document.createElement('div');
    root.id = 'yms-root';
    root.innerHTML = `
      <div class="yms-hdr"><h2>${ICON} YMS Multi-Color</h2><div class="yms-badge yms-b-off" id="yms-badge">...</div></div>
      <svg id="yms-svg" class="yms-svg" viewBox="0 0 600 400"></svg>
      <div class="yms-ctrls" id="yms-ctrls"></div>
      <div class="yms-info" id="yms-info">---</div>
    `;
    document.body.appendChild(root);
    return root;
  }

  // ── Show / Hide ──────────────────────────────────────────────────────
  function showYms() {
    if (!ymsDiv) ymsDiv = createRoot();

    // Hide ALL Mainsail visible content
    document.querySelectorAll('main, .v-main, .v-main__wrap').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.v-navigation-drawer--right').forEach(el => el.style.display = 'none');

    ymsDiv.classList.add('yms-show');
    ymsActive = true;
    if (ymsNavItem) ymsNavItem.classList.add('v-list-item--active');

    // Adjust position based on sidebar width
    adjustPos();

    // Start polling
    poll();
    if (!pollTimer) pollTimer = setInterval(poll, 1000);
  }

  function hideYms() {
    if (ymsDiv) ymsDiv.classList.remove('yms-show');

    // Restore ALL Mainsail content
    document.querySelectorAll('main, .v-main, .v-main__wrap').forEach(el => el.style.display = '');
    document.querySelectorAll('.v-navigation-drawer--right').forEach(el => el.style.display = '');

    ymsActive = false;
    if (ymsNavItem) ymsNavItem.classList.remove('v-list-item--active');

    // Stop polling
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function adjustPos() {
    if (!ymsDiv) return;
    const nav = document.querySelector('.v-navigation-drawer');
    if (!nav) return;
    const w = nav.offsetWidth || 256;
    const closed = nav.classList.contains('v-navigation-drawer--close');
    ymsDiv.style.left = closed ? '56px' : w + 'px';
  }

  // ── SVG Render ───────────────────────────────────────────────────────
  function render() {
    const svg = document.getElementById('yms-svg');
    if (!svg) return;
    svg.innerHTML = '';
    if (!D || !D.enabled) {
      svg.setAttribute('viewBox','0 0 600 60');
      svg.appendChild(sv('text',{x:300,y:35,fill:'#555','font-size':'13','text-anchor':'middle','font-family':'system-ui'},'YMS not detected'));
      return;
    }

    const n = D.num_slots;
    const M = 10;
    const cardW = 60, cardH = 70, cardG = 6;
    const totalW = n * (cardW + cardG) - cardG;
    const hasPro = D.slot_is_pro && D.slot_is_pro.some(v => v);
    const maxCardH = hasPro ? cardH + 18 : cardH;
    const tubeZone = 80;
    const hotW = Math.max(totalW * 0.6, 120), hotH = 36;
    const svgW = Math.max(totalW + M*2, hotW + M*4);
    const slotsX = (svgW - totalW) / 2;
    const slotsY = M;
    const hotX = (svgW - hotW) / 2;
    const hotY = slotsY + maxCardH + tubeZone;
    const centerX = svgW / 2;
    const tsY = hotY + hotH + 18;
    const nozY = tsY + 30;
    svg.setAttribute('viewBox', `0 0 ${svgW} ${nozY + 30}`);

    for (let i = 0; i < n; i++) {
      const x = slotsX + i * (cardW + cardG);
      const y = slotsY;
      const cx = x + cardW/2;
      const col = '#'+(D.slot_color[i]||'CCC');
      const act = D.slot === i;
      const st = D.slot_status[i];
      const name = D.slot_name[i]||`YMS-${i+1}`;
      const mat = D.slot_material[i]||'?';
      const isPro = D.slot_is_pro && D.slot_is_pro[i];
      const thisH = isPro ? cardH + 18 : cardH;

      svg.appendChild(sv('rect',{x,y,width:cardW,height:thisH,rx:8,class:act?'slot-card-act':'slot-card'}));
      svg.appendChild(sv('rect',{x:x+4,y:y+4,width:cardW-8,height:6,fill:col,rx:3}));
      if (isPro) {
        svg.appendChild(sv('rect',{x:x+cardW-22,y:y+2,width:20,height:10,rx:3,fill:'#E65100'}));
        svg.appendChild(sv('text',{x:x+cardW-12,y:y+9,fill:'#fff','font-size':'6','text-anchor':'middle','font-family':'system-ui','font-weight':'700'},'PRO'));
      }
      svg.appendChild(sv('text',{x:cx,y:y+22,class:'slot-txt'},name));
      svg.appendChild(sv('text',{x:cx,y:y+33,class:'slot-sub'},mat));
      if (isPro) {
        const dt = D.slot_dryer_temp?D.slot_dryer_temp[i]:0;
        const dd = D.slot_dryer_target?D.slot_dryer_target[i]:0;
        svg.appendChild(sv('text',{x:cx,y:y+43,fill:dd>0?'#FF9800':'#665','font-size':'8','text-anchor':'middle','font-family':'system-ui'},`\uD83D\uDD25 ${dt}\u00B0`));
      }
      const msY = isPro ? y+58 : y+48;
      svg.appendChild(sv('circle',{cx:cx-12,cy:msY,r:5,class:msC(st,act)}));
      svg.appendChild(sv('text',{x:cx-12,y:msY,class:'ms-lbl'},'MS'));
      svg.appendChild(sv('rect',{x:cx+4,y:msY-6,width:14,height:12,rx:3,class:act?'gear-on':'gear-off'}));
      svg.appendChild(sv('text',{x:cx+11,y:msY,class:'gear-ico'},'\u2699'));
      const mi = D.tool_to_slot_map?D.tool_to_slot_map.indexOf(i):i;
      svg.appendChild(sv('text',{x:cx,y:y+thisH-3,fill:act?'#5c9ce6':'#445','font-size':'8','text-anchor':'middle','font-family':'system-ui','font-weight':'600'},mi>=0?`T${mi}`:''));

      const tubeY0 = y + thisH;
      const entryX = hotX + 10 + (i/(n-1||1))*(hotW-20);
      const midY2 = tubeY0 + (hotY-tubeY0)*0.5;
      const path = `M${cx},${tubeY0} C${cx},${midY2} ${entryX},${midY2} ${entryX},${hotY}`;
      const tube = sv('path',{d:path,class:'tube '+(act?'tube-live flow':'tube-idle')});
      if (act) tube.setAttribute('stroke',col);
      svg.appendChild(tube);
      svg.appendChild(sv('circle',{cx:entryX,cy:hotY,r:2.5,fill:act?col:'#333'}));

      if (st===1||act) {
        let fp=0,lbl='';
        if (act&&D.toolhead_filament_detected){fp=1;lbl='loaded';}
        else if (act&&D.filament_path==='bowden'){fp=.88;lbl='standby';}
        else if (st===1){fp=.12;lbl='inserted';}
        if (fp>.01) {
          const fx=cx+(entryX-cx)*fp, fy=tubeY0+(hotY-tubeY0)*fp;
          svg.appendChild(sv('path',{d:path,fill:'none',stroke:col,'stroke-width':'3','stroke-linecap':'round','stroke-dasharray':`${fp*160} 9999`,opacity:'.5'}));
          svg.appendChild(sv('circle',{cx:fx,cy:fy,r:5,fill:col,class:'fp'+(act?' pulse':''),stroke:'#fff','stroke-width':'1.5'}));
          if (lbl) svg.appendChild(sv('text',{x:fx+(fx<centerX?-10:10),y:fy-8,class:'fp-lbl','text-anchor':fx<centerX?'end':'start'},lbl));
        }
      }
    }

    const acol = D.slot>=0?'#'+(D.slot_color[D.slot]||'CCC'):null;
    const fl = D.toolhead_filament_detected;
    const pr = D.print_state==='printing';

    svg.appendChild(sv('rect',{x:hotX,y:hotY,width:hotW,height:hotH,rx:8,class:'hot-box'}));
    svg.appendChild(sv('text',{x:centerX,y:hotY+hotH/2,class:'hot-lbl'},'HOTEND'));
    svg.appendChild(sv('line',{x1:centerX,y1:hotY+hotH,x2:centerX,y2:tsY-10,stroke:fl?(acol||'#4CAF50'):'#333','stroke-width':'3',class:pr?'flow':'','stroke-dasharray':pr?'6 3':'none'}));
    svg.appendChild(sv('circle',{cx:centerX-18,cy:tsY,r:8,class:fl?'ts-on':'ts-off'}));
    svg.appendChild(sv('text',{x:centerX-18,y:tsY,class:'ts-lbl'},'TS'));
    if (D.cutter_available) {
      const cg=sv('g',{style:'cursor:pointer'});
      cg.appendChild(sv('rect',{x:centerX+6,y:tsY-11,width:22,height:22,rx:4,class:D.cutter_enabled?'cut-on':'cut-off'}));
      cg.appendChild(sv('text',{x:centerX+17,y:tsY,class:'cut-ico'},'\u2702'));
      cg.onclick=()=>gc(`YMS_CUTTER ENABLE=${D.cutter_enabled?0:1}`);
      svg.appendChild(cg);
    }
    svg.appendChild(sv('line',{x1:centerX,y1:tsY+10,x2:centerX,y2:nozY-10,stroke:fl?(pr?'#e53935':(acol||'#4CAF50')):'#333','stroke-width':'3',class:pr?'flow':'','stroke-dasharray':pr?'6 3':'none'}));
    svg.appendChild(sv('polygon',{points:`${centerX-7},${nozY-8} ${centerX+7},${nozY-8} ${centerX+3},${nozY+8} ${centerX-3},${nozY+8}`,class:'noz',opacity:pr?'1':'.7'}));
    svg.appendChild(sv('text',{x:centerX,y:nozY+22,class:'noz-t'},`${eT}\u00B0C`));
  }

  // ── Controls ─────────────────────────────────────────────────────────
  function renderCtrls() {
    const box = document.getElementById('yms-ctrls');
    if (!box || !D || !D.enabled) return;
    box.innerHTML = '';
    const b = (l,fn,cls) => { const e=document.createElement('button'); e.className='yms-btn'+(cls?' '+cls:''); e.textContent=l; e.onclick=fn; return e; };

    box.appendChild(b('\u26A1 INIT YMS',()=>gc('YMS_INIT'),'yms-btn-init'));
    box.appendChild(b('T0 Detect',()=>gc('T0')));
    for (let i=0;i<D.num_slots;i++) {
      const btn=b(`T${i+1} ${D.slot_name[i]}`,()=>gc(`T${i+1}`));
      if (D.slot===i) btn.classList.add('active');
      box.appendChild(btn);
    }
    box.appendChild(document.createElement('br'));
    box.appendChild(b('TOFF',()=>gc('TOFF')));
    box.appendChild(b('Check',()=>gc('YMS_CHECK_SLOTS')));
    if (D.cutter_available) {
      const cb=b(D.cutter_enabled?'Cutter ON':'Cutter OFF',()=>gc(`YMS_CUTTER ENABLE=${D.cutter_enabled?0:1}`));
      if (D.cutter_enabled) cb.classList.add('active');
      box.appendChild(cb);
    }
  }

  function updateUI() {
    const badge=document.getElementById('yms-badge');
    const info=document.getElementById('yms-info');
    if (!badge||!info) return;
    if (!D) { badge.textContent='Offline'; badge.className='yms-badge yms-b-off'; info.innerHTML='---'; return; }
    if (D.print_state==='printing') { badge.textContent='Printing'; badge.className='yms-badge yms-b-print'; }
    else if (D.enabled) { badge.textContent=`Ready \u2022 ${D.num_slots} slots`; badge.className='yms-badge yms-b-ready'; }
    else { badge.textContent='No YMS'; badge.className='yms-badge yms-b-off'; }
    const as=D.slot>=0?D.slot_name[D.slot]:'none';
    info.innerHTML=`Active: <span>${as}</span> | Filament: <span>${D.filament}</span> (${D.filament_path}) | Mapping: <span>${D.mapping||'---'}</span>`;
  }

  // ── API ──────────────────────────────────────────────────────────────
  async function poll() {
    try {
      const r=await fetch(`${API}/printer/objects/query?yms_manager&extruder`);
      const j=await r.json();
      D=j.result.status.yms_manager||null;
      eT=Math.round(j.result.status.extruder?.temperature||0);
    } catch(e){D=null;}
    render(); renderCtrls(); updateUI();
  }

  async function gc(cmd) {
    try{await fetch(`${API}/printer/gcode/script`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({script:cmd})});}catch(e){}
    setTimeout(poll,500);
  }

  // ── Sidebar injection ────────────────────────────────────────────────
  function injectSidebar(nav) {
    const list = nav.querySelector('.v-list')||nav;
    const items = list.querySelectorAll('a.v-list-item, .v-list-item');
    if (!items.length) return false;

    // Prevent duplicate injection
    if (list.querySelector('a[href="#yms"]')) return true;

    let insertBefore = null;
    items.forEach(item => { if (item.textContent.trim().toUpperCase()==='MACHINE') insertBefore=item; });

    ymsNavItem = document.createElement('a');
    ymsNavItem.href = '#yms';
    // Copy exact classes from Mainsail nav items (remove active state)
    ymsNavItem.className = items[0].className.replace(/v-list-item--active/g, '').replace(/active-nav-item/g, '').trim();
    ymsNavItem.style.textDecoration = 'none';
    ymsNavItem.innerHTML = `
      <div class="v-list-item__icon my-3 mr-3 menu-item-icon">${ICON}</div>
      <div class="v-list-item__content">
        <div class="v-list-item__title menu-item-title">YMS Multi-Color</div>
      </div>`;

    ymsNavItem.addEventListener('click', function(e) {
      e.preventDefault(); e.stopPropagation();
      ymsActive ? hideYms() : showYms();
    });

    if (insertBefore) insertBefore.parentNode.insertBefore(ymsNavItem, insertBefore);
    else list.appendChild(ymsNavItem);

    // Clicking other nav items restores Mainsail
    items.forEach(item => item.addEventListener('click', () => { if (ymsActive) hideYms(); }));

    return true;
  }

  // ── Keyboard (Ctrl+Y) ───────────────────────────────────────────────
  document.addEventListener('keydown', e => { if (e.ctrlKey&&e.key==='y'){e.preventDefault();ymsActive?hideYms():showYms();} });

  // ── Init ─────────────────────────────────────────────────────────────
  async function init() {
    try {
      const nav = await waitFor('.v-navigation-drawer', MAX_WAIT);
      await new Promise(r => setTimeout(r, 3000));
      if (injectSidebar(nav)) console.log('[YMS] Injected');
      else { console.warn('[YMS] Retry...'); setTimeout(init, 3000); }
    } catch(e) { console.warn('[YMS]',e); setTimeout(init, 5000); }
  }

  document.readyState==='loading' ? document.addEventListener('DOMContentLoaded',init) : init();
})();
