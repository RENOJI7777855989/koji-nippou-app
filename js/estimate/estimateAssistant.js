/* ==========================================================
   積算データへの自然文質問（Claude APIを使用）
   このアプリで唯一、外部（Anthropic）へネットワーク通信を行う箇所。
   サーバーを持たないため、ユーザー自身のAPIキーをこの端末の
   IndexedDB（metaストア）に保存し、質問のたびにブラウザから直接
   Anthropic APIへ送信する。数量・単価・金額はestimateItemsの
   実データをそのままプロンプトに埋め込み、AIには「検索・要約・
   自然文化」だけを担わせ、数値を推測させない。
   ========================================================== */

import { dbGet, dbPut, dbDelete } from "../db.js";
import { listEstimateItemsBySite } from "./estimateItems.js";

const API_KEY_META_KEY = "anthropicApiKey";
const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

export async function getApiKey() {
  const record = await dbGet("meta", API_KEY_META_KEY);
  return record?.value || "";
}

export async function setApiKey(key) {
  await dbPut("meta", { key: API_KEY_META_KEY, value: key.trim() });
}

export async function clearApiKey() {
  await dbDelete("meta", API_KEY_META_KEY);
}

function buildItemsForPrompt(items) {
  return items.map((item) => ({
    工種: item.category || "",
    項目: item.itemName || "",
    仕様: item.spec || "",
    数量: item.quantity,
    単位: item.unit || "",
    単価: item.unitPrice,
    金額: item.amount,
    出典資料: item.sourceFileName || "",
    出典シート_ページ: item.sourceSheet || "",
    出典行: item.sourceRow ?? null
  }));
}

function buildSystemPrompt(itemsJson) {
  return `あなたは工事の積算内訳データについて質問に答えるアシスタントです。

以下のJSONは、この現場の積算内訳（構造化データ）です。回答は必ずこのデータだけを根拠にしてください。
- データに無い数量・単価・金額を推測したり創作したりしないでください。該当する項目が見つからない場合は、その旨を正直に答えてください。
- 具体的な数値を答える際は、工種・単価・金額・出典（出典資料・出典シート_ページ・出典行）を含めてください。
- 「合計」「〇〇関係の項目を全部出して」「100万円以上の項目」のような集計・絞り込みの質問には、与えられた数値を自分で計算・抽出して答えてください。
- 日本語で、簡潔で読みやすい自然文で答えてください。

積算内訳データ（JSON）:
${JSON.stringify(itemsJson)}`;
}

function friendlyErrorMessage(status) {
  if (status === 401) return "APIキーが正しくないか、無効になっています。キーを確認してください。";
  if (status === 429) return "Anthropic APIの利用上限（レート制限）に達しました。しばらく待ってから再試行してください。";
  if (status >= 500) return "Anthropic API側で一時的な問題が発生しています。しばらくしてから再試行してください。";
  return `Anthropic APIへのリクエストに失敗しました（status: ${status}）。`;
}

/**
 * 現場の積算データを根拠に、自然文の質問にAIが回答する。
 * @param {{ siteId: string, question: string }} params
 * @returns {Promise<string>} 回答テキスト
 */
export async function askEstimateQuestion({ siteId, question }) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error("Anthropic APIキーが設定されていません。まずAPIキーを設定してください。");
  }

  const items = await listEstimateItemsBySite(siteId);
  if (items.length === 0) {
    throw new Error("この現場にはまだ積算データがありません。先に積算書を取り込んでください。");
  }

  const systemPrompt = buildSystemPrompt(buildItemsForPrompt(items));

  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        thinking: { type: "disabled" },
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: question }]
      })
    });
  } catch (err) {
    throw new Error("Anthropic APIへの通信に失敗しました。ネットワーク接続を確認してください。");
  }

  if (!response.ok) {
    throw new Error(friendlyErrorMessage(response.status));
  }

  const data = await response.json();
  const textBlock = (data.content || []).find((block) => block.type === "text");
  if (!textBlock) {
    throw new Error("回答を取得できませんでした。もう一度お試しください。");
  }
  return textBlock.text;
}
