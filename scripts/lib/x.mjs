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

async function fetchWithRetry(url, options = {}, { retries = 3, label = "" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        ...options,
        headers: { "user-agent": UA, ...(options.headers || {}) },
        signal: AbortSignal.timeout(20000),
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
  const json = await res.json();
  if (!json.guest_token) throw new Error("guest token を取得できませんでした");
  guestTokenCache = json.guest_token;
  return guestTokenCache;
}

/**
 * @handle から数値IDを解決する。
 * @returns {Promise<{id:string, username:string, displayName:string, createdAt:string, protected:boolean}|null>}
 *          存在しない/凍結などで取得できない場合は null
 */
export async function userByScreenName(screenName) {
  const gt = await getGuestToken();
  const url =
    `https://api.x.com/graphql/${USER_BY_SCREEN_NAME_QID}/UserByScreenName` +
    `?variables=${encodeURIComponent(JSON.stringify({ screen_name: screenName }))}` +
    `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;

  const res = await fetchWithRetry(
    url,
    { headers: { authorization: `Bearer ${BEARER}`, "x-guest-token": gt } },
    { label: "UserByScreenName" },
  );
  if (!res.ok) throw new Error(`UserByScreenName HTTP ${res.status}`);

  const json = await res.json();
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
  if (res.status === 404) return null;
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

/** 証拠URLから {username, tweetId} を取り出す */
export function parseTweetUrl(url) {
  const m = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/([0-9]{1,25})(?:[/?#].*)?$/.exec(
    url.trim(),
  );
  if (!m) return null;
  return { username: m[1], tweetId: m[2] };
}

/** 入力（URL / @handle / handle）から screen_name を抽出 */
export function parseHandleInput(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const urlMatch = /^https?:\/\/(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#].*)?$/i.exec(s);
  if (urlMatch) return urlMatch[1];
  const handleMatch = /^@?([A-Za-z0-9_]{1,15})$/.exec(s);
  if (handleMatch) return handleMatch[1];
  return null;
}

export const today = () => new Date().toISOString().slice(0, 10);
