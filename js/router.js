/* ==========================================================
   location.hashベースの簡易ルーター（ライブラリ不使用）
   例: #/sites, #/sites/:id, #/sites/:id/edit,
       #/sites/:id/report/new, #/sites/:id/report/:reportId
   登録順に最初にマッチしたルートを採用するため、main.jsでは
   具体的なパターンを先に、汎用的な":id"パターンを後に登録する
   ========================================================== */

const routes = [];

export function registerRoute(pattern, handler) {
  const paramNames = [];
  const regexStr = "^" + pattern.replace(/:[^/]+/g, (m) => {
    paramNames.push(m.slice(1));
    return "([^/]+)";
  }) + "$";
  routes.push({ regex: new RegExp(regexStr), paramNames, handler });
}

function resolve() {
  const raw = location.hash.replace(/^#/, "") || "/sites";
  const [path, queryString] = raw.split("?");
  const query = Object.fromEntries(new URLSearchParams(queryString || ""));

  for (const route of routes) {
    const match = path.match(route.regex);
    if (match) {
      const params = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      route.handler(params, query);
      return;
    }
  }

  location.hash = "#/sites";
}

export function startRouter() {
  window.addEventListener("hashchange", resolve);
  resolve();
}

export function navigate(path) {
  location.hash = `#${path}`;
}
