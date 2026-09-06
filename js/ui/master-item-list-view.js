/* ==========================================================
   共通積算項目マスター管理画面
   全現場共通のグローバルな項目辞書（js/vendorQuote/masterItems.js）
   を一覧・編集する。比較画面で「同一項目」を確定すると自動的に
   ここへ登録されるが、この画面からも標準項目名・工種の修正、
   別名の追加・削除、重複登録の統合、削除ができる。
   ========================================================== */

import {
  listMasterItems,
  renameMasterItem,
  addAliasToMasterItem,
  deleteMasterItem,
  mergeMasterItems
} from "../vendorQuote/index.js";
import { escapeHtml } from "../utils.js";
import { showView, showMessage } from "./common.js";
import { navigate } from "../router.js";

const backBtn = document.getElementById("backToSiteListFromMasterItemsBtn");
const searchInput = document.getElementById("masterItemSearchInput");
const emptyEl = document.getElementById("masterItemListEmpty");
const listEl = document.getElementById("masterItemList");

let allItems = [];
let editingId = null; // インライン編集中のカードid

function applyFilter() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return allItems;
  return allItems.filter((m) =>
    [m.itemCode, m.category, m.standardName, ...(m.aliases || [])].some((v) => (v || "").toLowerCase().includes(q))
  );
}

function aliasChipsHtml(item) {
  return (item.aliases || [])
    .map(
      (alias) => `<span class="master-alias-chip">${escapeHtml(alias)}
        <button type="button" class="removeAliasBtn" data-id="${item.id}" data-alias="${escapeHtml(alias)}" title="この別名を削除">×</button>
      </span>`
    )
    .join("");
}

function mergeOptionsHtml(item) {
  const others = allItems.filter((m) => m.id !== item.id);
  if (others.length === 0) return "";
  const options = others.map((m) => `<option value="${m.id}">${escapeHtml(m.itemCode)} ${escapeHtml(m.standardName)}</option>`).join("");
  return `<div class="master-item-merge">
    <select class="mergeTargetSelect" data-id="${item.id}">${options}</select>
    <button type="button" class="secondary-btn mergeIntoBtn" data-id="${item.id}">この項目に統合する</button>
  </div>`;
}

function cardHtml(item) {
  const isEditing = editingId === item.id;
  const header = isEditing
    ? `<div class="master-item-edit-form">
        <label>工種
          <input type="text" class="editCategoryInput" data-id="${item.id}" value="${escapeHtml(item.category)}">
        </label>
        <label>標準項目名
          <input type="text" class="editStandardNameInput" data-id="${item.id}" value="${escapeHtml(item.standardName)}">
        </label>
        <label>代表的な単位
          <input type="text" class="editUnitInput" data-id="${item.id}" value="${escapeHtml(item.unit || "")}">
        </label>
        <div class="toolbar">
          <button type="button" class="saveEditBtn" data-id="${item.id}">保存</button>
          <button type="button" class="secondary-btn cancelEditBtn">キャンセル</button>
        </div>
      </div>`
    : `<div class="master-item-header">
        <span class="master-code-badge">${escapeHtml(item.itemCode)}</span>
        <span class="master-item-category">${escapeHtml(item.category) || "工種未設定"}</span>
        <strong class="master-item-name">${escapeHtml(item.standardName)}</strong>
        ${item.unit ? `<span class="master-item-unit">単位: ${escapeHtml(item.unit)}</span>` : ""}
        <button type="button" class="secondary-btn editItemBtn" data-id="${item.id}">編集</button>
        <button type="button" class="secondary-btn deleteItemBtn" data-id="${item.id}">削除</button>
      </div>`;

  return `<li class="master-item-card" data-id="${item.id}">
    ${header}
    <div class="master-item-aliases">
      別名: ${aliasChipsHtml(item) || "（なし）"}
      <div class="master-add-alias">
        <input type="text" class="addAliasInput" data-id="${item.id}" placeholder="別名を追加">
        <button type="button" class="secondary-btn addAliasBtn" data-id="${item.id}">追加</button>
      </div>
    </div>
    ${mergeOptionsHtml(item)}
  </li>`;
}

function render() {
  const filtered = applyFilter();
  emptyEl.style.display = allItems.length === 0 ? "block" : "none";
  listEl.hidden = allItems.length === 0;
  listEl.innerHTML = filtered.map(cardHtml).join("");
}

async function reload() {
  allItems = await listMasterItems();
  render();
}

searchInput.addEventListener("input", render);
backBtn.addEventListener("click", () => navigate("/sites"));

listEl.addEventListener("click", async (e) => {
  const editBtn = e.target.closest(".editItemBtn");
  if (editBtn) {
    editingId = editBtn.dataset.id;
    render();
    return;
  }
  const cancelBtn = e.target.closest(".cancelEditBtn");
  if (cancelBtn) {
    editingId = null;
    render();
    return;
  }
  const saveBtn = e.target.closest(".saveEditBtn");
  if (saveBtn) {
    const id = saveBtn.dataset.id;
    const card = listEl.querySelector(`.master-item-card[data-id="${id}"]`);
    const category = card.querySelector(".editCategoryInput").value.trim();
    const standardName = card.querySelector(".editStandardNameInput").value.trim();
    const unit = card.querySelector(".editUnitInput").value.trim();
    if (!standardName) {
      showMessage("標準項目名を入力してください。", true);
      return;
    }
    await renameMasterItem(id, { category, standardName, unit });
    editingId = null;
    showMessage("更新しました。");
    await reload();
    return;
  }

  const deleteBtn = e.target.closest(".deleteItemBtn");
  if (deleteBtn) {
    const item = allItems.find((m) => m.id === deleteBtn.dataset.id);
    if (!item) return;
    if (!confirm(`「${item.standardName}」（${item.itemCode}）を削除しますか？削除すると、この項目コードによる自動照合が効かなくなります。`)) return;
    await deleteMasterItem(item.id);
    showMessage("削除しました。");
    await reload();
    return;
  }

  const addAliasBtn = e.target.closest(".addAliasBtn");
  if (addAliasBtn) {
    const id = addAliasBtn.dataset.id;
    const input = listEl.querySelector(`.addAliasInput[data-id="${id}"]`);
    const value = input.value.trim();
    if (!value) return;
    await addAliasToMasterItem(id, value);
    showMessage("別名を追加しました。");
    await reload();
    return;
  }

  const removeAliasBtn = e.target.closest(".removeAliasBtn");
  if (removeAliasBtn) {
    const id = removeAliasBtn.dataset.id;
    const alias = removeAliasBtn.dataset.alias;
    const item = allItems.find((m) => m.id === id);
    if (!item) return;
    if (item.aliases.length <= 1) {
      showMessage("最後の別名（標準項目名）は削除できません。", true);
      return;
    }
    await renameMasterItem(id, { aliases: item.aliases.filter((a) => a !== alias) });
    showMessage("別名を削除しました。");
    await reload();
    return;
  }

  const mergeBtn = e.target.closest(".mergeIntoBtn");
  if (mergeBtn) {
    const fromId = mergeBtn.dataset.id;
    const select = listEl.querySelector(`.mergeTargetSelect[data-id="${fromId}"]`);
    const intoId = select.value;
    const fromItem = allItems.find((m) => m.id === fromId);
    const intoItem = allItems.find((m) => m.id === intoId);
    if (!fromItem || !intoItem) return;
    if (!confirm(`「${fromItem.standardName}」を「${intoItem.standardName}」（${intoItem.itemCode}）に統合しますか？「${fromItem.itemCode}」は削除され、別名は統合先に引き継がれます。`)) return;
    await mergeMasterItems(intoId, fromId);
    showMessage("統合しました。");
    await reload();
  }
});

export async function initMasterItemListView() {
  editingId = null;
  searchInput.value = "";
  showView("view-master-items");
  await reload();
}
