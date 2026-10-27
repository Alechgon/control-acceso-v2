/* Alechcora — SPA (base Datácora; "Alechcora" es solo el nombre visible)
 * Mapa + Gestión desde datos.js (SOSER) y módulos en vivo contra el backend.
 * MISMO direccionamiento que Datácora:
 *   POST /auth/login {email,password} -> {access_token,user}
 *   GET  /api/catalogs | /api/users | /api/tasks | /api/establishments
 *   POST /api/tasks {type,description,dueDate,priority,status,assignedTo,establishmentId,rbd}
 * En APK, CapacitorHttp intercepta fetch() (sin CORS) y server.cleartext permite HTTP.
 * No hay credenciales en este archivo; el token lo da el backend y vive solo en memoria.
 */
"use strict";

const API_BASE = (window.ALECHCORA_API_BASE || "").replace(/\/$/, "");
const SESSION_KEY = "alechcora_session";
const TASK_TYPES = ["Plan Preventivo Mantención", "DT", "Mutualidad", "Emergencia", "Acta", "Seremi", "SEC"];
const PRIORIDADES = ["Alta", "Media", "Baja"];

const state = {
  token: "", user: null,
  view: "mapa",
  cache: {}, loading: false, error: "",
  modal: null,
  gestion: { sup: "", desde: "", hasta: "" },
  backendUsers: null, backendEst: null,
};

/* ───────────────── datos SOSER (datos.js) ───────────────── */
const S = (typeof window !== "undefined" && window.SOSER) || { ESTAB: [], HIST: [], DC: [], BITS: [] };
const ESTAB = S.ESTAB || [];
const VIS = {};
function pushVisit(rbd, v) { (VIS[rbd] = VIS[rbd] || []).push(v); }
(S.HIST || []).forEach(h => pushVisit(h.rbd, { fecha: h.fecha, tipo: h.tipo || "", tec: h.tec || "", folio: h.folio || "", parte: h.parte || "", fuente: "Historial" }));
(S.DC || []).forEach(d => pushVisit(d.rbd, { fecha: d.fecha, tipo: d.tipo || "", tec: d.tec || "", folio: d.folio || "", parte: d.inst || "", fuente: "Datácora", det: d.det || "", revision: d.revision || "" }));
const BITS_BY_FOLIO = {};
(S.BITS || []).forEach(b => { if (b.folio != null) BITS_BY_FOLIO[String(b.folio)] = b; });
Object.values(VIS).forEach(list => list.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))));

const ESTAB_BY_RBD = {};
ESTAB.forEach(e => ESTAB_BY_RBD[e.rbd] = e);
const SUPS = Array.from(new Set(ESTAB.map(e => e.sup).filter(Boolean))).sort();

function visitsFor(rbd) { return VIS[rbd] || []; }
function classify(e) {
  const vs = visitsFor(e.rbd);
  if (!vs.length) return "verde";
  const prev = vs.some(v => /prevent/i.test(v.tipo));
  const otra = vs.some(v => !/prevent/i.test(v.tipo));
  if (prev && otra) return "ambas";
  if (prev) return "azul";
  return "rojo";
}
const COLORS = { verde: "#2f9e8f", azul: "#2563eb", rojo: "#d64545", ambas: "#d64545" };
const COLOR_LABEL = { verde: "Sin visitas", azul: "Preventiva", rojo: "Correctiva (sin preventiva)", ambas: "Correctiva + Preventiva" };

/* ───────────────── API (mismo helper que Datácora) ───────────────── */
async function api(path, { method = "GET", body = null } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : null });
  if (res.status === 401) { logout(); throw new Error("Sesión expirada, vuelve a entrar."); }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
  return data;
}
function pick(o, ...ks) { for (const k of ks) { const v = o && o[k]; if (v !== undefined && v !== null && v !== "") return v; } return ""; }
function asRows(d) { if (Array.isArray(d)) return d; if (d && typeof d === "object") for (const k of ["items", "data", "results", "tasks", "users", "establishments"]) if (Array.isArray(d[k])) return d[k]; return d ? [d] : []; }
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ───────────────── login ───────────────── */
async function login(ev) {
  ev.preventDefault();
  const f = ev.target, email = f.email.value.trim(), password = f.password.value;
  state.error = ""; const b = f.querySelector("button"); b.disabled = true; b.textContent = "Entrando…";
  try {
    const s = await api("/auth/login", { method: "POST", body: { email, password } });
    state.token = pick(s, "access_token", "token", "jwt");
    state.user = s.user || { email };
    if (!state.token) throw new Error("El backend no devolvió token.");
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: state.token, user: state.user })); } catch {}
    state.view = "mapa"; render(); mount();
  } catch (e) { state.error = e.message; render(); }
}
function logout() { state.token = ""; state.user = null; state.backendUsers = state.backendEst = null; try { sessionStorage.removeItem(SESSION_KEY); } catch {} render(); }
function restore() { try { const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); if (s && s.token) { state.token = s.token; state.user = s.user; } } catch {} }

/* ───────────────── módulos ───────────────── */
const MODULES = {
  mapa:            { label: "Mapa",            icon: "🗺️", backend: false },
  gestion:         { label: "Gestión",         icon: "📑", backend: false },
  tareas:          { label: "Tareas",          icon: "🧰", backend: true, endpoint: "/api/tasks" },
  establecimientos:{ label: "Establecimientos", icon: "🏫", backend: true, endpoint: "/api/establishments" },
  usuarios:        { label: "Usuarios",        icon: "👥", backend: true, endpoint: "/api/users" },
};
function go(view) { state.view = view; state.modal = null; render(); mount(); if (MODULES[view] && MODULES[view].backend && !state.cache[view]) loadBackend(view); }

function render() {
  const mod = MODULES[state.view];
  const nav = Object.entries(MODULES).map(([k, m]) =>
    `<a class="${k === state.view ? "on" : ""}" href="#" onclick="go('${k}');return false">${m.icon} ${m.label}</a>`).join("");
  const who = state.token
    ? `<b>${esc(pick(state.user, "full_name", "nombre", "email") || "Conectado")}</b><button class="ghost" onclick="logout()" style="width:100%;margin-top:.5rem">Salir</button>`
    : `<span class="hint" style="color:#9fb8cf">Sin sesión</span><button class="sec" onclick="go('login')" style="width:100%;margin-top:.5rem">Entrar</button>`;
  let content;
  if (state.view === "login") content = viewLoginInline();
  else if (state.view === "mapa") content = viewMapa();
  else if (state.view === "gestion") content = viewGestion();
  else if (mod.backend && !state.token) content = `<div class="empty">Esta sección necesita tu sesión. <button onclick="go('login')">Entrar</button></div>`;
  else content = viewBackend();
  document.getElementById("app").innerHTML = `
  <div class="shell">
    <aside class="side">
      <div class="brand">Alechcora<small>mantención SOSER</small></div>
      <nav class="nav">${nav}</nav>
      <div class="who">${who}</div>
    </aside>
    <main class="main">
      <div class="topbar"><h2>${mod ? mod.icon + " " + mod.label : "Entrar"}</h2><div class="spacer"></div></div>
      ${content}
    </main>
  </div>
  ${state.modal ? renderModal() : ""}`;
}

/* ───────────────── MAPA ───────────────── */
let mapObj = null;
function viewMapa() {
  const counts = { verde: 0, azul: 0, rojo: 0, ambas: 0 };
  ESTAB.forEach(e => counts[classify(e)]++);
  const chip = (k) => `<span class="legend"><i style="background:${k === 'ambas' ? 'linear-gradient(90deg,#d64545 50%,#2563eb 50%)' : COLORS[k]}"></i>${COLOR_LABEL[k]} <b>${counts[k]}</b></span>`;
  return `<div class="legendbar">${chip("rojo")}${chip("ambas")}${chip("azul")}${chip("verde")}
      <span class="spacer"></span><span class="count">${ESTAB.length} establecimientos</span></div>
    <div id="map" class="mapbox"></div>`;
}
function mount() {
  if (mapObj) { try { mapObj.remove(); } catch {} mapObj = null; }
  if (state.view !== "mapa") return;
  const el = document.getElementById("map");
  if (!el || typeof L === "undefined") return;
  mapObj = L.map(el, { scrollWheelZoom: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapObj);
  const pts = [];
  ESTAB.forEach(e => {
    if (typeof e.lat !== "number" || typeof e.lon !== "number") return;
    const k = classify(e);
    const html = k === "ambas"
      ? `<span class="pin" style="background:linear-gradient(90deg,#d64545 50%,#2563eb 50%)"></span>`
      : `<span class="pin" style="background:${COLORS[k]}"></span>`;
    const icon = L.divIcon({ className: "pinwrap", html, iconSize: [20, 20], iconAnchor: [10, 10] });
    const m = L.marker([e.lat, e.lon], { icon }).addTo(mapObj);
    const vs = visitsFor(e.rbd);
    m.bindPopup(`<div class="pop">
        <a href="#" class="pop-name" onclick="openFicha(${e.rbd});return false">${esc(e.nombre)}</a>
        <div class="pop-row"><b>Supervisor:</b> ${esc(e.sup || "—")}</div>
        <div class="pop-row"><b>Dirección:</b> ${esc(e.dir || "—")}${e.comuna ? ", " + esc(e.comuna) : ""}</div>
        <div class="pop-row"><b>Institución:</b> ${esc(e.inst || "—")} · <b>Visitas:</b> ${vs.length}</div>
        <div class="pop-tag" style="background:${k === 'ambas' ? '#d64545' : COLORS[k]}">${COLOR_LABEL[k]}</div>
        <button class="pop-btn" onclick="openVisita(${e.rbd})">+ Agregar visita</button></div>`);
    pts.push([e.lat, e.lon]);
  });
  if (pts.length) mapObj.fitBounds(pts, { padding: [30, 30] }); else mapObj.setView([-33.45, -70.66], 11);
}

/* ───────────────── FICHA / VISITA ───────────────── */
function openFicha(rbd) { state.modal = { tipo: "ficha", rbd }; render(); }
function openVisita(rbd) { state.modal = { tipo: "visita", rbd, msg: "" }; render(); if (state.token) ensureBackendData(); }
function closeModal() { state.modal = null; render(); mount(); }
function renderModal() { return state.modal.tipo === "ficha" ? modalFicha() : modalVisita(); }

function modalFicha() {
  const e = ESTAB_BY_RBD[state.modal.rbd]; if (!e) return "";
  const vs = visitsFor(e.rbd);
  const rows = vs.map(v => `<tr><td>${esc(v.fecha)}</td><td>${badge(v.tipo)}</td><td>${esc(v.tec || "—")}</td><td>${esc(v.folio || "—")}</td><td>${esc(v.parte || "—")}</td><td>${esc(v.fuente)}</td></tr>`).join("");
  return `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
      <header><h3>${esc(e.nombre)}</h3><span class="count">RBD ${e.rbd}</span><div class="spacer"></div>
        <button class="sec" onclick="openVisita(${e.rbd})">+ Agregar visita</button>
        <button class="ghost" onclick="closeModal()">Cerrar</button></header>
      <div class="body">
        <div class="kv">
          <div class="k">Supervisor</div><div>${esc(e.sup || "—")}</div>
          <div class="k">Dirección</div><div>${esc(e.dir || "—")}${e.comuna ? ", " + esc(e.comuna) : ""}</div>
          <div class="k">Institución</div><div>${esc(e.inst || "—")}</div>
          <div class="k">Cobertura</div><div>${esc(e.cobertura || "—")}</div>
        </div>
        <h4>Bitácoras / visitas (${vs.length})</h4>
        ${vs.length ? `<div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Técnico</th><th>Folio</th><th>Parte</th><th>Fuente</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">Sin visitas registradas.</div>`}
      </div></div></div>`;
}

async function ensureBackendData() {
  try {
    if (!state.backendUsers) state.backendUsers = asRows(await api("/api/users"));
    if (!state.backendEst) state.backendEst = asRows(await api("/api/establishments"));
    render();
  } catch (e) { /* queda el aviso */ }
}
function modalVisita() {
  const e = ESTAB_BY_RBD[state.modal.rbd]; if (!e) return "";
  if (!state.token) return `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box"><header><h3>Agregar visita</h3><div class="spacer"></div><button class="ghost" onclick="closeModal()">Cerrar</button></header><div class="body"><div class="empty">Necesitas tu sesión para crear la tarea. <button onclick="go('login')">Entrar</button></div></div></div></div>`;
  const techs = (state.backendUsers || []).filter(u => !/supervisor|admin/i.test(pick(u, "cargo", "role_name", "role") || ""));
  const techOpts = (techs.length ? techs : (state.backendUsers || [])).map(u => `<option value="${esc(u.id)}">${esc(pick(u, "full_name", "nombre", "usuario", "email"))}</option>`).join("");
  const hoy = new Date().toISOString().slice(0, 10);
  return `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
      <header><h3>Agregar visita · ${esc(e.nombre)}</h3><span class="count">RBD ${e.rbd}</span><div class="spacer"></div><button class="ghost" onclick="closeModal()">Cerrar</button></header>
      <div class="body">
        ${state.modal.msg ? `<div class="msg ${state.modal.ok ? "ok" : "err"}">${esc(state.modal.msg)}</div>` : ""}
        ${!state.backendUsers ? `<div class="hint">Cargando técnicos…</div>` : ""}
        <form onsubmit="crearVisita(event, ${e.rbd})">
          <div class="field"><label>Tipo de tarea</label><select name="type">${TASK_TYPES.map(t => `<option>${t}</option>`).join("")}</select></div>
          <div class="field"><label>Técnico</label><select name="assignedTo" required>${techOpts || '<option value="">(sin técnicos)</option>'}</select></div>
          <div class="field"><label>Fecha</label><input type="date" name="dueDate" value="${hoy}"></div>
          <div class="field"><label>Prioridad</label><select name="priority">${PRIORIDADES.map(p => `<option>${p}</option>`).join("")}</select></div>
          <div class="field"><label>Descripción</label><input name="description" placeholder="Detalle de la visita"></div>
          <button type="submit">Crear tarea</button>
        </form>
      </div></div></div>`;
}
async function crearVisita(ev, rbd) {
  ev.preventDefault();
  const f = ev.target;
  const est = (state.backendEst || []).find(x => String(pick(x, "rbd")) === String(rbd));
  const payload = { type: f.type.value, description: f.description.value, dueDate: f.dueDate.value, priority: f.priority.value, status: "pendiente", assignedTo: f.assignedTo.value, establishmentId: est ? est.id : undefined, rbd };
  const btn = f.querySelector("button"); btn.disabled = true; btn.textContent = "Creando…";
  try {
    const created = await api("/api/tasks", { method: "POST", body: payload });
    state.modal.ok = true; state.modal.msg = `Tarea creada${created && created.id ? " (" + created.id + ")" : ""}.`;
    state.cache.tareas = null;
  } catch (err) {
    state.modal.ok = false; state.modal.msg = "No se pudo crear: " + err.message + (est ? "" : " (no encontré establishmentId por RBD).");
  }
  render();
}

/* ───────────────── GESTIÓN ───────────────── */
function viewGestion() {
  const g = state.gestion;
  const supOpts = `<option value="">— elige supervisora —</option>` + SUPS.map(s => `<option ${s === g.sup ? "selected" : ""}>${esc(s)}</option>`).join("");
  let bloques = "", tabla = "", total = 0;
  if (g.sup) {
    const ests = ESTAB.filter(e => e.sup === g.sup && visitsFor(e.rbd).length);
    bloques = ests.map(e => `<label class="block"><input type="checkbox" class="rbdchk" value="${e.rbd}" checked onchange="render()"> <b>${e.rbd}</b> ${esc(e.nombre)} <span class="count">${visitsFor(e.rbd).length}</span></label>`).join("") || `<div class="hint">Sin establecimientos con visitas.</div>`;
    const rows = gestionRows(); total = rows.length;
    tabla = rows.length ? `<div class="tablewrap"><table><thead><tr><th>Fecha</th><th>RBD</th><th>Establecimiento</th><th>Tipo</th><th>Técnico</th><th>Folio</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.fecha)}</td><td>${r.rbd}</td><td>${esc(r.estab)}</td><td>${badge(r.tipo)}</td><td>${esc(r.tec)}</td><td>${esc(r.folio)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Sin bitácoras para ese filtro.</div>`;
  }
  return `<div class="toolbar">
      <div><label class="lbl">Supervisora</label><select onchange="setSup(this.value)">${supOpts}</select></div>
      <div><label class="lbl">Desde</label><input type="date" value="${g.desde}" onchange="state.gestion.desde=this.value;render()"></div>
      <div><label class="lbl">Hasta</label><input type="date" value="${g.hasta}" onchange="state.gestion.hasta=this.value;render()"></div>
      <span class="spacer"></span>
      ${g.sup ? `<button onclick="exportarGestion()">⬇ Descargar ZIP (${total})</button>` : ""}
    </div>
    ${g.sup ? `<h4>Establecimientos atendidos de ${esc(g.sup)}</h4><div class="blocks">${bloques}</div><h4>Bitácoras (recientes primero) · ${total}</h4>${tabla}` : `<div class="empty">Elige una supervisora para ver sus RBD atendidos.</div>`}`;
}
function setSup(v) { state.gestion.sup = v; render(); }
function selectedRbds() { return Array.from(document.querySelectorAll(".rbdchk:checked")).map(c => Number(c.value)); }
function gestionRows() {
  const g = state.gestion;
  const rbds = (document.querySelectorAll(".rbdchk").length ? selectedRbds() : ESTAB.filter(e => e.sup === g.sup && visitsFor(e.rbd).length).map(e => e.rbd));
  const out = [];
  rbds.forEach(rbd => { const e = ESTAB_BY_RBD[rbd]; visitsFor(rbd).forEach(v => {
    if (g.desde && String(v.fecha) < g.desde) return;
    if (g.hasta && String(v.fecha) > g.hasta) return;
    out.push({ fecha: v.fecha, rbd, estab: e ? e.nombre : "", comuna: e ? e.comuna : "", tipo: v.tipo, tec: v.tec, folio: v.folio, sup: g.sup });
  }); });
  out.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  return out;
}

/* ─── Excel mínimo en JS (inlineStr + HYPERLINK) ─── */
async function makeXlsx(headers, rows, sheet) {
  const xml = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const col = n => { let s = ""; n++; while (n) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const cell = (ref, v) => {
    if (v && typeof v === "object" && v.link) { const u = String(v.link).replace(/"/g, ""); const t = xml(v.text || "Abrir"); return `<c r="${ref}" t="str"><f>HYPERLINK(&quot;${xml(u)}&quot;,&quot;${t}&quot;)</f><v>${t}</v></c>`; }
    if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
  };
  let body = ""; [headers, ...rows].forEach((row, ri) => { body += `<row r="${ri + 1}">` + row.map((v, ci) => cell(col(ci) + (ri + 1), v)).join("") + `</row>`; });
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${body}</sheetData></worksheet>`;
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheet || "Hoja1").slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const z = new JSZip();
  z.file("[Content_Types].xml", ct); z.file("_rels/.rels", rootRels); z.file("xl/workbook.xml", wb); z.file("xl/_rels/workbook.xml.rels", wbRels); z.file("xl/worksheets/sheet1.xml", sheetXml);
  return await z.generateAsync({ type: "uint8array" });
}
function blobToB64(blob) { return new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(",")[1]); fr.readAsDataURL(blob); }); }
async function saveFile(blob, filename) {
  const Cap = window.Capacitor;
  if (Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins && Cap.Plugins.Filesystem) {
    try {
      const data = await blobToB64(blob);
      const res = await Cap.Plugins.Filesystem.writeFile({ path: filename, data, directory: "CACHE" });
      if (Cap.Plugins.Share) await Cap.Plugins.Share.share({ title: filename, url: res.uri });
      return;
    } catch (e) { /* cae a descarga */ }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
}
async function exportarGestion() {
  const rows = gestionRows();
  if (!rows.length) return alert("No hay bitácoras para exportar.");
  const headers = ["Folio", "Fecha", "RBD", "Establecimiento", "Comuna", "Tipo", "Técnico", "Supervisora", "Bitácora"];
  const xrows = rows.map(r => {
    const bit = BITS_BY_FOLIO[String(r.folio)];
    return [r.folio, r.fecha, r.rbd, r.estab, r.comuna, r.tipo, r.tec, r.sup, bit && bit.archivo ? bit.archivo : "—"];
  });
  try {
    const xlsx = await makeXlsx(headers, xrows, "Bitácoras");
    const zip = new JSZip();
    zip.file("catalogo.xlsx", xlsx);
    zip.folder("bitacoras").file("LEEME.txt",
      `Bitácoras: ${rows.length}\nSupervisora: ${state.gestion.sup}\n\nLos PDF se agregan cuando el backend exponga el endpoint de PDF por folio.\nEl catálogo (catalogo.xlsx) trae la lista completa.\n`);
    const blob = await zip.generateAsync({ type: "blob" });
    await saveFile(blob, "Bitacoras_" + state.gestion.sup.replace(/\s+/g, "_") + ".zip");
  } catch (e) { alert("No se pudo exportar: " + e.message); }
}

/* ───────────────── módulos backend ───────────────── */
async function loadBackend(view) {
  state.loading = true; state.error = ""; render();
  try { state.cache[view] = asRows(await api(MODULES[view].endpoint)); }
  catch (e) { state.error = e.message; state.cache[view] = []; }
  finally { state.loading = false; render(); }
}
const COLS = {
  tareas: [["ID", r => pick(r, "id", "folio")], ["Tipo", r => pick(r, "type", "tipo")], ["RBD", r => pick(r, "rbd")], ["Establecimiento", r => pick(r, "establishment", "establishment_name")], ["Asignado", r => pick(r, "assigned_to_name", "assignedTo", "assigned_to")], ["Estado", r => pick(r, "status", "estado")], ["Prioridad", r => pick(r, "priority", "prioridad")]],
  establecimientos: [["RBD", r => pick(r, "rbd")], ["Nombre", r => pick(r, "name", "nombre")], ["Comuna", r => pick(r, "commune", "comuna")], ["Dirección", r => pick(r, "address", "direccion")]],
  usuarios: [["Nombre", r => pick(r, "full_name", "nombre", "name")], ["Usuario", r => pick(r, "usuario", "email")], ["Cargo", r => pick(r, "cargo", "role_name", "role")], ["Estado", r => pick(r, "estado", "status")]],
};
function viewBackend() {
  const cols = COLS[state.view] || [], rows = state.cache[state.view] || [];
  let body;
  if (state.loading) body = `<div class="empty">Cargando…</div>`;
  else if (state.error) body = `<div class="msg err">${esc(state.error)}</div>`;
  else if (!rows.length) body = `<div class="empty">Sin registros.</div>`;
  else body = `<div class="tablewrap"><table><thead><tr>${cols.map(c => `<th>${c[0]}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => c[0] === "Estado" ? `<td>${badge(c[1](r))}</td>` : `<td>${esc(c[1](r)) || "—"}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  return `<div class="toolbar"><button class="sec" onclick="loadBackend('${state.view}')">↻ Actualizar</button><span class="count">${rows.length} registro(s)</span></div>${body}`;
}

function viewLoginInline() {
  return `<div class="logincard"><form class="card" onsubmit="login(event)">
    <h1>Entrar</h1><p class="sub">Tu usuario de Datácora.</p>
    ${state.error ? `<div class="msg err">${esc(state.error)}</div>` : ""}
    <div class="field"><label>Correo</label><input name="email" autocomplete="username" required autofocus></div>
    <div class="field"><label>Contraseña</label><input name="password" type="password" autocomplete="current-password" required></div>
    <button style="width:100%">Entrar</button></form></div>`;
}
function badge(t) {
  const x = String(t || "").toLowerCase(); let c = "mut";
  if (/prevent|complet|cerrad|ok|activ|realiz/.test(x)) c = "ok";
  else if (/correct|pend|emerg|proces/.test(x)) c = "warn";
  return `<span class="badge ${c}">${esc(t) || "—"}</span>`;
}

Object.assign(window, { login, logout, go, openFicha, openVisita, closeModal, crearVisita, setSup, exportarGestion, loadBackend, render, state });
restore(); render(); mount();
