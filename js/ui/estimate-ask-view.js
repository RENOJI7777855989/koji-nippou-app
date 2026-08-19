/* ==========================================================
   積算データへの自然文質問画面
   Anthropic APIキーの初回セットアップ（この端末のIndexedDBにのみ
   保存）と、質問フォーム・回答履歴表示を扱う。
   実際の質問処理（プロンプト組み立て・API呼び出し）は
   js/estimate/estimateAssistant.jsに委譲する。
   ========================================================== */

import { getSite } from "../sites.js";
import { getApiKey, setApiKey, clearApiKey, askEstimateQuestion } from "../estimate/index.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";
import { canAccessSite } from "../auth.js";

const backBtn = document.getElementById("backToEstimateListFromAskBtn");
const siteNameEl = document.getElementById("estimateAskSiteName");
const setupSection = document.getElementById("estimateAskSetupSection");
const apiKeyInput = document.getElementById("estimateAskApiKeyInput");
const saveKeyBtn = document.getElementById("estimateAskSaveKeyBtn");
const mainSection = document.getElementById("estimateAskMainSection");
const changeKeyBtn = document.getElementById("estimateAskChangeKeyBtn");
const form = document.getElementById("estimateAskForm");
const questionInput = document.getElementById("estimateAskQuestionInput");
const submitBtn = document.getElementById("estimateAskSubmitBtn");
const loadingEl = document.getElementById("estimateAskLoading");
const historyEl = document.getElementById("estimateAskHistory");

let currentSite = null;

async function refreshKeyState() {
  const key = await getApiKey();
  const hasKey = !!key;
  setupSection.hidden = hasKey;
  mainSection.hidden = !hasKey;
  return hasKey;
}

function addHistoryEntry(question, answer, isError) {
  const li = document.createElement("li");
  li.className = "estimate-ask-entry";
  li.innerHTML = `
    <p class="estimate-ask-question">${escapeHtml(question)}</p>
    <p class="estimate-ask-answer${isError ? " error" : ""}">${escapeHtml(answer)}</p>
  `;
  historyEl.insertBefore(li, historyEl.firstChild);
}

backBtn.addEventListener("click", () => navigate(`/sites/${currentSite.id}/estimates`));

saveKeyBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showMessage("APIキーを入力してください。", true);
    return;
  }
  await setApiKey(key);
  apiKeyInput.value = "";
  await refreshKeyState();
  showMessage("APIキーを保存しました。");
});

changeKeyBtn.addEventListener("click", async () => {
  if (!confirm("保存済みのAPIキーを削除しますか？")) return;
  await clearApiKey();
  await refreshKeyState();
  showMessage("APIキーを削除しました。");
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  submitBtn.disabled = true;
  loadingEl.hidden = false;
  try {
    const answer = await askEstimateQuestion({ siteId: currentSite.id, question });
    addHistoryEntry(question, answer, false);
    questionInput.value = "";
  } catch (err) {
    addHistoryEntry(question, err.message || "回答の取得に失敗しました。", true);
  } finally {
    submitBtn.disabled = false;
    loadingEl.hidden = true;
  }
});

export async function initEstimateAskView(params) {
  const site = await getSite(params.id);
  if (!site) {
    showMessage("現場が見つかりませんでした。", true);
    navigate("/sites");
    return;
  }
  if (!canAccessSite(site)) {
    showMessage("この現場を閲覧する権限がありません。", true);
    navigate("/sites");
    return;
  }
  currentSite = site;
  siteNameEl.textContent = `（${site.name}）`;
  apiKeyInput.value = "";
  questionInput.value = "";
  historyEl.innerHTML = "";
  showView("view-estimate-ask");
  await refreshKeyState();
}
