/* ==========================================================
   印刷用HTMLの中で動かすスクリプトの本文（2026-11-01。CSP の指紋（ハッシュ）で許可するため、中身を固定する）
   index.html の Content-Security-Policy は、インラインのスクリプトを、ここにある本文の SHA-256 だけ許す。印刷用HTMLは
   プレビュー・印刷の枠（iframe の srcdoc）の中で表示し、枠は親の CSP を引き継ぐので、本文を1文字でも変えたら index.html の
   指紋も変える（tests/csp.js が、印刷用HTMLの中のスクリプトがすべて許可されているかを確かめる）。
   紙面の大きさなど文書ごとに変わる数値は、スクリプトの直前に置いた <script type="application/json">（実行されない）から読む。
   ========================================================== */

/** 会社様式（03-2）の日報・台帳の、紙面の全体の縮小（直前の JSON: {aw, ah, ratio, sel}） */
export const SHEET_FIT_SCRIPT = `(function(){var s=document.currentScript,p=s&&s.previousElementSibling,o={};try{o=JSON.parse(p.textContent)}catch(e){}var AW=o.aw,AH=o.ah,RATIO=o.ratio,SEL=o.sel;if(!SEL)return;function fit(){var ws=document.querySelectorAll(SEL);for(var i=0;i<ws.length;i++){var w=ws[i];var t=w.querySelector("table.xlsx-sheet");if(!t)continue;w.style.zoom="1";w.style.width="";var r=t.getBoundingClientRect();if(!r.width||!r.height)continue;var WW=Math.max(r.width,r.height/RATIO);w.style.width=WW+"px";var z=Math.min(1,AW/WW*0.995,AH/r.height*0.97);w.style.zoom=z<0.99?String(z):"1";}}fit();window.addEventListener("load",fit);window.addEventListener("beforeprint",fit);})();`;

/** 会社様式の、セルの文字を箱に収める（文字を小さくして折り返す） */
export const CELL_FIT_SCRIPT = `(function(){
  var MIN=5;
  function fitCell(c){
    var sp=c.firstElementChild; if(!sp) return true;
    c.classList.remove("xc-fit"); c.style.fontSize="";
    var own=+c.getAttribute("data-w"), spill=+c.getAttribute("data-spill"), wrap=c.getAttribute("data-wrap")==="1";
    if(!wrap && sp.offsetWidth<=spill+0.5 && sp.offsetHeight<=c.clientHeight+1) return true;
    c.classList.add("xc-fit");
    var size=parseFloat(getComputedStyle(c).fontSize)||14;
    function over(){return c.scrollHeight>c.clientHeight||c.scrollWidth>c.clientWidth;}
    while(over()&&size>MIN){size-=0.5;c.style.fontSize=size+"px";}
    return !over();
  }
  // 全体の縮小（下の fitScript）は、この後に計算し直す。縮小したまま測ると幅・高さを誤るので一度戻す
  function fitAll(){var ws=document.querySelectorAll(".xlsx-sheet-wrap");for(var j=0;j<ws.length;j++)ws[j].style.zoom="1";var n=0,cs=document.querySelectorAll("table.xlsx-sheet .xc[data-w]");for(var i=0;i<cs.length;i++){if(!fitCell(cs[i]))n++;}window.__xlsxCellsClipped=n;}
  fitAll();window.addEventListener("load",fitAll);window.addEventListener("beforeprint",fitAll);
})();`;

/** 現場掲示 A3「今日の現場シート」の、欄ごとの文字の縮小 */
export const TODAY_SHEET_FIT_SCRIPT = `(function(){
    function over(c){return c.scrollHeight>c.clientHeight+1||c.scrollWidth>c.clientWidth+1;}
    function fitBox(c){var size=10.5;c.style.fontSize=size+"pt";while(over(c)&&size>6){size-=0.5;c.style.fontSize=size+"pt";}return !over(c);}
    function fitAll(){document.querySelectorAll(".box .content").forEach(fitBox);}
    function fit(){
      var works=document.querySelector(".worksbox");
      var heights=[80,95,110,125];
      if(works){works.style.maxHeight="";works.style.flex="";}
      fitAll();
      for(var i=0;works&&over(works.querySelector(".content"))&&i<heights.length;i++){
        works.style.maxHeight="none";works.style.flex="0 0 "+heights[i]+"mm";
        fitAll();
      }
      // それでも収まらない欄（最小6ptでも入りきらない）がある日は、紙面にその旨を出す（黙って切らない）。window.__a3Overflow は検証用
      var over6=[].slice.call(document.querySelectorAll(".box .content")).filter(over);
      window.__a3Overflow=over6.map(function(c){return c.parentNode.getAttribute("data-section");});
      var warn=document.querySelector(".a3-overflow-warn");
      if(warn)warn.remove();
      if(over6.length){
        warn=document.createElement("div");warn.className="a3-overflow-warn";
        warn.textContent="※情報が多く、一部の欄（"+over6.map(function(c){return c.parentNode.querySelector("h2").textContent;}).join("・")+"）が1枚に収まりません。内容は画面・日報で確認してください。";
        document.querySelector(".sheet").appendChild(warn);
      }
    }
    fit();window.addEventListener("load",fit);window.addEventListener("beforeprint",fit);})();`;

/** アプリ独自のPDF（会社様式が無いとき）の、A4 1ページへの縮小（id="print-fit-params" の JSON: {w, h}） */
export const ORIGINAL_PDF_FIT_SCRIPT = `  (function () {
    // A4縦・余白12mmでの印刷可能領域（96dpi換算px）。@pageの設定と対応させている。
    var P = (function () { try { return JSON.parse(document.getElementById("print-fit-params").textContent); } catch (e) { return {}; } })();
    var TARGET_WIDTH_PX = P.w;
    var TARGET_HEIGHT_PX = P.h;

    function fitToOnePage() {
      var content = document.getElementById("page-content");
      var outer = document.getElementById("page-outer");
      if (!content || !outer) return;
      content.style.transform = "none";
      content.style.width = TARGET_WIDTH_PX + "px";
      var naturalHeight = content.scrollHeight;
      var scale = Math.min(1, TARGET_HEIGHT_PX / naturalHeight);
      content.style.transform = "scale(" + scale + ")";
      outer.style.width = TARGET_WIDTH_PX + "px";
      outer.style.height = Math.ceil(naturalHeight * scale) + "px";
    }

    window.addEventListener("load", fitToOnePage);
    window.addEventListener("beforeprint", fitToOnePage);
    window.addEventListener("resize", fitToOnePage);
    if (document.readyState === "complete") fitToOnePage();
  })();
  `;

/** 実行されない JSON のスクリプト（数値を渡す）。"<" は書かない */
export function jsonParamsScript(obj, id = "") {
  return `<script type="application/json"${id ? ` id="${id}"` : ""} class="print-fit-params">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
}

/** 印刷用HTMLの中で使う、許可するスクリプトの本文の一覧（指紋の計算・検査用） */
export const PRINT_SCRIPTS = [SHEET_FIT_SCRIPT, CELL_FIT_SCRIPT, TODAY_SHEET_FIT_SCRIPT, ORIGINAL_PDF_FIT_SCRIPT];
