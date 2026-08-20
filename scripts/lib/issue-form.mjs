// GitHub Issue Form の本文を扱う。

/** Issue Form の本文を "### 見出し" 単位で分解する */
export function parseIssueForm(body) {
 const sections = {};
 const parts = String(body ?? "")
  .split(/^###\s+/m)
  .slice(1);
 for (const part of parts) {
  const nl = part.indexOf("\n");
  const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
  const value = (nl === -1 ? "" : part.slice(nl + 1)).trim();
  sections[heading] =
   value === "_No response_" ? "" : stripWrappingCodeFence(value);
 }
 return sections;
}

/**
 * 値ぜんたいが1つのコードブロックで包まれている場合だけ、その囲いを外す。
 * Issue Form の `render:` 付き項目は本文にコードブロックとして出力されるため、
 * 中身だけを取り出す必要がある。
 * 途中に出てくるコードブロックには触らない。
 */
function stripWrappingCodeFence(value) {
 const m = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/.exec(value);
 return m ? m[2].trim() : value;
}

/**
 * 本文中のチェックボックスを拾う。
 * GitHub はチェック済みを `- [X]`、未チェックを `- [ ]` で出す。
 * @returns {{checked:boolean, label:string}[]}
 */
export function parseCheckboxes(text) {
 return [
  ...String(text ?? "").matchAll(/^[ \t]*[-*]\s*\[([ xX])\][ \t]*(.*)$/gm),
 ].map((m) => ({ checked: m[1] !== " ", label: m[2].trim() }));
}
