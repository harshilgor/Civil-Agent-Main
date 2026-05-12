import { state, on } from "../state.js";
import { mount, on as delegate } from "../utils/dom.js";
import { icon } from "../utils/icons.js";
import { iconBtn } from "../utils/helpers.js";

let host;

function context() {
  if (state.selectedObject) {
    return `Scheme ${state.activeSchemeId} · ${state.activeLevelId} · ${state.selectedObject.id}`;
  }
  return `Scheme ${state.activeSchemeId} · ${state.page}`;
}

function suggestions() {
  return {
    geometry: ["What geometry needs review?", "Show opening conflicts", "Which grids are irregular?"],
    placement: ["Why these column locations?", "Try fewer interior columns", "Regenerate around locked"],
    loads: ["Show load path for C4", "What controls axial load?", "Unapproved load assumptions?"],
    schemes: ["Compare A and B", "Most constructible scheme?", "Why is C cheaper?"],
    sizing: ["Why is B21 failing?", "Members over 0.90 D/C", "Reduce beam depth"],
    assumptions: ["Changes since last snapshot?", "Geotech assumptions?"],
    vault: ["Geotech extraction status?", "What needs review?"],
    reports: ["Draft narrative", "Sources in this report?"],
  }[state.page] || ["What should I review?", "What changed recently?"];
}

function answer() {
  if (state.selectedObject?.id === "B21") return "B21 is near capacity because live-load deflection controls on a 31.8 ft span.";
  if (state.selectedObject?.id === "SW2") return "SW2 fails the E-W shear check by 4%. Thickening, extending, or adding a paired wall would resolve it.";
  if (state.page === "schemes") return "Scheme A is currently the best balance of cost, drift, and constructability.";
  return "I can explain the current deterministic workflow state and open the relevant source data.";
}

function render() {
  if (!host) return;
  if (!state.assistantOpen) {
    mount(host, "");
    return;
  }
  const prompts = suggestions();
  mount(
    host,
    `<aside class="assistant-drawer" role="dialog" aria-label="Ask CivilAgent">
      <div class="assistant-head">
        <div>
          <span class="assistant-context">${context()}</span>
          <h2 style="margin:0;color:var(--text-primary);font-size:var(--text-md);font-weight:500">Ask CivilAgent</h2>
        </div>
        ${iconBtn("close", { label: "Close assistant", data: { action: "close-assistant" } })}
      </div>
      <div class="assistant-thread">
        <div class="assistant-msg assistant-msg-bot">
          <p style="margin:0;color:var(--text-primary)">${answer()}</p>
          <h4>Why</h4>
          <p>Deterministic checks use active Scheme ${state.activeSchemeId} and the approved assumption set.</p>
          <h4>Data used</h4>
          <p>Active project · selected object · assumptions · member checks · referenced Vault docs.</p>
        </div>
      </div>
      <div class="assistant-suggested">${prompts.map((p) => `<button data-prompt="${p}">${p}</button>`).join("")}</div>
      <form class="assistant-input" data-form="ask">
        <input placeholder="Ask about this project..." />
        <button type="submit" class="btn btn-primary btn-sm">Ask</button>
      </form>
    </aside>`,
  );
}

export function initAssistantDrawer() {
  host = document.createElement("div");
  host.id = "assistant-host";
  document.body.appendChild(host);

  delegate(host, "click", "[data-action='close-assistant']", () => {
    state.assistantOpen = false;
  });
  delegate(host, "submit", "form", (e) => {
    e.preventDefault();
    state.assistantOpen = false;
  });

  on("assistantOpen", render);
  on("selectedObject", render);
  on("page", render);
  render();
}
