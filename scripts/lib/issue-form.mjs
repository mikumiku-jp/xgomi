// GitHub Issue Form の本文を扱う。

/** Issue Form の本文を "### 見出し" 単位で分解する */
export function parseIssueForm(body) {
  const sections = {};
  const parts = String(body ?? "").split(/^###\s+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    const value = (nl === -1 ? "" : part.slice(nl + 1)).trim();
    sections[heading] = value === "_No response_" ? "" : value;
  }
  return sections;
}
