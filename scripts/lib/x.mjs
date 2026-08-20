// X (Twitter) の公開エンドポイントへの薄いクライアント。APIキー不要。
// 依存パッケージなし（Node 18+ の fetch を使用）。

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// web クライアントが公開している固定 bearer（秘密情報ではない）
const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const USER_BY_SCREEN_NAME_QID = "G3KGOASz96M-Qu0nwmGXNg";

const FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(
  url,
  options = {},
  { retries = 3, label = "", timeout = 20000 } = {},
) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        ...options,
        headers: { "user-agent": UA, ...(options.headers || {}) },
        signal: AbortSignal.timeout(timeout),
      });
      // 429/5xx はリトライ対象
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${label} HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error(`${label} failed`);
}

let guestTokenCache = null;

export async function getGuestToken(force = false) {
  if (guestTokenCache && !force) return guestTokenCache;
  const res = await fetchWithRetry(
    "https://api.x.com/1.1/guest/activate.json",
    { method: "POST", headers: { authorization: `Bearer ${BEARER}` } },
    { label: "guest/activate" },
  );
  const json = await res.json().catch(() => ({}));
  if (!json.guest_token)
    throw new Error("ゲストトークンを取得できませんでした");
  guestTokenCache = json.guest_token;
  return guestTokenCache;
}

/**
 * ゲストトークン付きで GraphQL を叩く。
 * トークンは時間経過やリクエスト数で失効するため、
 * 拒否されたら取り直して一度だけやり直す。
 */
async function graphql(queryId, operation, variables, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const gt = await getGuestToken(attempt > 0);
    const url =
      `https://api.x.com/graphql/${queryId}/${operation}` +
      `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;

    const res = await fetchWithRetry(
      url,
      { headers: { authorization: `Bearer ${BEARER}`, "x-guest-token": gt } },
      { label },
    );

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      guestTokenCache = null;
      if (attempt === 0) continue;
      throw new Error(
        `${label} HTTP ${res.status}（ゲストトークンを取り直しても拒否されました）`,
      );
    }
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`${label} に失敗しました`);
}

/**
 * @handle から数値IDを解決する。
 * @returns {Promise<{id:string, username:string, displayName:string, createdAt:string, protected:boolean}|null>}
 *          存在しない/凍結などで取得できない場合は null
 */
export async function userByScreenName(screenName) {
  const json = await graphql(
    USER_BY_SCREEN_NAME_QID,
    "UserByScreenName",
    { screen_name: screenName },
    "UserByScreenName",
  );
  const result = json?.data?.user?.result;
  if (!result || result.__typename !== "User" || !result.rest_id) return null;

  const legacy = result.legacy ?? {};
  return {
    id: String(result.rest_id),
    username: legacy.screen_name ?? screenName,
    displayName: legacy.name ?? "",
    createdAt: legacy.created_at ?? "",
    protected: Boolean(legacy.protected),
  };
}

/**
 * ツイートIDから投稿者を解決する。
 * screen_name は「現在の」ハンドルが返るため、ID→username の逆引きにも使える。
 * @returns {Promise<{authorId:string, authorUsername:string, text:string, createdAt:string}|null>}
 */
export async function tweetById(tweetId) {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(tweetId)}&token=a&lang=ja`;
  const res = await fetchWithRetry(url, {}, { label: "tweet-result" });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`tweet-result HTTP ${res.status}`);

  const text = await res.text();
  if (!text.trim()) return null;

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const user = json?.user;
  if (!user?.id_str) return null;

  return {
    authorId: String(user.id_str),
    authorUsername: user.screen_name ?? "",
    text: json.text ?? "",
    createdAt: json.created_at ?? "",
  };
}

// 報告者が貼りがちなミラーや旧ドメインをまとめて受け付ける
const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "m.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "m.twitter.com",
  "vxtwitter.com",
  "www.vxtwitter.com",
  "fxtwitter.com",
  "www.fxtwitter.com",
  "fixupx.com",
  "fixvx.com",
  "twittpr.com",
]);

function toUrl(s) {
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
}

/**
 * 証拠URLを解釈する。ミラー、`?s=20` などの追跡パラメータ、
 * 末尾の /photo/1 を吸収して正規形を返す。
 * @returns {{username:string, tweetId:string, canonical:string}|null}
 */
export function parseTweetUrl(url) {
  const s = String(url ?? "").trim();
  if (!s) return null;

  const u = toUrl(s);
  if (!u || !X_HOSTS.has(u.hostname.toLowerCase())) return null;

  const m = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/([0-9]{1,25})/.exec(
    u.pathname,
  );
  if (!m) return null;

  return {
    username: m[1],
    tweetId: m[2],
    canonical: `https://x.com/${m[1]}/status/${m[2]}`,
  };
}

/** URL が既に正規形かどうか */
export function isCanonicalTweetUrl(url) {
  const parsed = parseTweetUrl(url);
  return Boolean(parsed) && parsed.canonical === String(url ?? "").trim();
}

/**
 * 入力（URL / @handle / handle / 数値ID）を分類する。
 * ハンドルは15文字以内で数字のみも許されるため、短い数字列は
 * ハンドルと数値IDのどちらとも取れる。その場合は ambiguous を返す。
 * @returns {{kind:"handle"|"numeric-id"|"ambiguous"|"invalid", value?:string, reason?:string}}
 */
export function classifyAccountInput(input) {
  const s = String(input ?? "").trim();
  if (!s) return { kind: "invalid", reason: "空です" };

  if (/^https?:\/\//i.test(s) || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(s)) {
    const u = toUrl(s);
    if (!u) return { kind: "invalid", reason: "URL として読めません" };
    if (!X_HOSTS.has(u.hostname.toLowerCase())) {
      return {
        kind: "invalid",
        reason: `${u.hostname} は X のドメインではありません`,
      };
    }
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg.length === 0) {
      return { kind: "invalid", reason: "URL にユーザー名が含まれていません" };
    }
    if (seg[0] === "i" && seg[1] === "user" && /^[0-9]+$/.test(seg[2] ?? "")) {
      return { kind: "numeric-id", value: seg[2] };
    }
    if (!/^[A-Za-z0-9_]{1,15}$/.test(seg[0])) {
      return {
        kind: "invalid",
        reason: `「${seg[0]}」はユーザー名の形式ではありません`,
      };
    }
    return { kind: "handle", value: seg[0] };
  }

  const bare = s.replace(/^@/, "");

  if (/^[0-9]+$/.test(bare)) {
    // ハンドルは15文字以内。それを超えていれば数値ID で確定できる
    if (bare.length > 15) return { kind: "numeric-id", value: bare };
    return { kind: "ambiguous", value: bare };
  }

  if (/^[A-Za-z0-9_]{1,15}$/.test(bare)) return { kind: "handle", value: bare };

  if (/^[A-Za-z0-9_]+$/.test(bare)) {
    return {
      kind: "invalid",
      reason: `「${bare}」は ${bare.length} 文字あります。ユーザー名は15文字以内です`,
    };
  }
  return {
    kind: "invalid",
    reason: `「${bare}」にはユーザー名に使えない文字が含まれています（使えるのは英数字と _ だけ）`,
  };
}

/** 従来形式の互換ラッパー。ハンドルを抽出できなければ null */
export function parseHandleInput(input) {
  const c = classifyAccountInput(input);
  return c.kind === "handle" || c.kind === "ambiguous" ? c.value : null;
}

// --------------------------------------------------------------------------
// Wayback Machine
// --------------------------------------------------------------------------

/**
 * 既存の魚拓を探す。なければ null。
 * @returns {Promise<string|null>} スナップショットのURL
 */
export async function waybackLookup(url) {
  try {
    const res = await fetchWithRetry(
      `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
      {},
      { label: "wayback/available", retries: 1, timeout: 15000 },
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const snap = json?.archived_snapshots?.closest;
    if (!snap?.available || !snap.url) return null;
    return String(snap.url).replace(/^http:/, "https:");
  } catch {
    return null;
  }
}

/**
 * 魚拓を新規に取るよう依頼する。
 * Wayback 側の混雑で失敗することが多いので、失敗は無視して null を返す。
 */
export async function waybackSave(url) {
  try {
    const res = await fetch(`https://web.archive.org/save/${url}`, {
      method: "GET",
      headers: { "user-agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return null;
    const loc = res.headers.get("content-location");
    if (loc) return `https://web.archive.org${loc}`;
    return res.url?.includes("/web/") ? res.url : null;
  } catch {
    return null;
  }
}

/** 既存の魚拓を探し、なければ保存を試みる */
export async function archiveUrl(url) {
  return (await waybackLookup(url)) ?? (await waybackSave(url));
}

export const today = () => new Date().toISOString().slice(0, 10);
