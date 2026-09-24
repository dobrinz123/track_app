// Rejection panel shared by the Clips and Posts pages.
// Usage: RejectPanel.open(kind, id, cardEl, onDone) with kind "video" | "post".
(() => {
  const catalogs = {};
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

  const css = `
  .rej { grid-column: 1 / -1; border: 1px solid rgba(255,59,48,.45); background: rgba(255,59,48,.06); border-radius: 14px;
         padding: 16px; display: grid; gap: 14px; }
  .rej h4 { margin: 0; font-size: 15px; }
  .rej .groups { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .rej fieldset { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; margin: 0; display: grid; gap: 6px; }
  .rej legend { padding: 0 6px; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .rej label { display: flex; gap: 8px; align-items: center; font-size: 14px; cursor: pointer; }
  .rej input[type=checkbox] { width: 17px; height: 17px; accent-color: var(--amber); }
  .rej textarea { min-height: 60px; }
  .rej .rec { font-size: 13px; color: var(--muted); }
  .rej .rec b { color: var(--text); }
  .rej .btns { display: flex; gap: 8px; flex-wrap: wrap; }
  .rej .btns button.hi { background: var(--amber); color: #111; border: 0; font-weight: 800; }
  .rej .btns .del.hi { background: var(--red); color: #fff; }
  .rej .err { color: var(--red); font-size: 13px; }
  @media (max-width: 700px) { .rej .groups { grid-template-columns: 1fr; } }`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  async function catalog(kind) {
    if (!catalogs[kind]) catalogs[kind] = await (await fetch(`/api/reasons/${kind}`)).json();
    return catalogs[kind];
  }

  async function open(kind, id, card, onDone) {
    const existing = card.querySelector(".rej"); if (existing) { existing.remove(); return; }
    const cat = await catalog(kind);
    const box = (g, r) => `<label><input type="checkbox" data-g="${g}" value="${r.id}"> ${esc(r.label)}</label>`;
    const el = document.createElement("div");
    el.className = "rej";
    el.innerHTML = `
      <h4>De ce îl respingi?</h4>
      <div class="groups">
        <fieldset><legend>Ideea</legend>${cat.idea.map(r => box("idea", r)).join("")}</fieldset>
        <fieldset><legend>Execuția</legend>${cat.exec.map(r => box("exec", r)).join("")}</fieldset>
      </div>
      <textarea placeholder="Observații (opțional) — ex: hook-ul să înceapă cu o întrebare; mai puțin text pe slide 3."></textarea>
      <div class="rec">Bifează motivele. Dacă ideea e proastă, o ștergem și nu mai revine. Dacă doar execuția e proastă, regenerăm aceeași idee cu observațiile tale.</div>
      <div class="btns">
        <button class="regen">🔁 Regenerează cu observațiile</button>
        <button class="del">🗑 Șterge (ideea nu mai revine)</button>
        <button class="keep">Doar marchează respins</button>
        <button class="cancel">Anulează</button>
      </div>
      <div class="err"></div>`;
    card.appendChild(el);
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });

    const regen = el.querySelector(".regen"), del = el.querySelector(".del"), rec = el.querySelector(".rec");
    function update() {
      const idea = [...el.querySelectorAll('[data-g="idea"]:checked')].length;
      const exec = [...el.querySelectorAll('[data-g="exec"]:checked')].length;
      const note = el.querySelector("textarea").value.trim().length > 0;
      regen.classList.toggle("hi", !idea && (exec > 0 || note));
      del.classList.toggle("hi", idea > 0);
      rec.innerHTML = idea ? "<b>Recomandat: Șterge.</b> Problema e ideea: regenerarea ar repeta-o."
        : (exec || note) ? "<b>Recomandat: Regenerează.</b> Ideea e bună, se reface execuția cu observațiile tale."
        : "Bifează motivele. Dacă ideea e proastă, o ștergem și nu mai revine. Dacă doar execuția e proastă, regenerăm aceeași idee cu observațiile tale.";
    }
    el.addEventListener("change", update); el.querySelector("textarea").addEventListener("input", update);

    async function send(action) {
      const reasons = [...el.querySelectorAll("input:checked")].map(i => i.value);
      const comment = el.querySelector("textarea").value;
      if (action === "regenerate" && !reasons.length && !comment.trim()) {
        el.querySelector(".err").textContent = "Spune ce e de corectat: bifează un motiv de execuție sau scrie o observație."; return;
      }
      if (!reasons.length && !comment.trim() && action !== "keep") {
        el.querySelector(".err").textContent = "Bifează măcar un motiv, ca programul să învețe din el."; return;
      }
      el.querySelectorAll("button").forEach(b => b.disabled = true);
      const r = await fetch(`/api/${kind === "video" ? "videos" : "posts"}/${id}/reject`, {
        method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ reasons, comment, action }) });
      const d = await r.json();
      if (!r.ok) { el.querySelector(".err").textContent = d.error || "Eroare"; el.querySelectorAll("button").forEach(b => b.disabled = false); return; }
      el.remove(); onDone(d);
    }
    regen.onclick = () => send("regenerate");
    del.onclick = () => send("delete");
    el.querySelector(".keep").onclick = () => send("keep");
    el.querySelector(".cancel").onclick = () => el.remove();
  }
  window.RejectPanel = { open };
})();
