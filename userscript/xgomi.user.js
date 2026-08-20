// ==UserScript==
// @name         xgomi - X blocklist filter
// @namespace    https://github.com/mikumiku-jp/xgomi
// @version      1.0.0
// @description  xgomiのブロックリストに載っているアカウントとその投稿を X から非表示にします
// @author       mikumiku-jp
// @license      MIT
// @homepageURL  https://github.com/mikumiku-jp/xgomi
// @supportURL   https://github.com/mikumiku-jp/xgomi/issues
// @downloadURL  https://raw.githubusercontent.com/mikumiku-jp/xgomi/main/userscript/xgomi.user.js
// @updateURL    https://raw.githubusercontent.com/mikumiku-jp/xgomi/main/userscript/xgomi.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://mobile.x.com/*
// @match        https://mobile.twitter.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      raw.githubusercontent.com
// @connect      github.com
// @connect      githubusercontent.com
// ==/UserScript==

(() => {
  const W = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;

  const DEFAULT_SOURCE =
    "https://raw.githubusercontent.com/mikumiku-jp/xgomi/main/dist/blocklist.csv";
  const LEGACY_SOURCES = [
    "https://raw.githubusercontent.com/mikumiku-jp/xgomi/main/dist/ids.txt",
  ];

  const K = {
    sources: "xg_sources",
    local: "xg_local",
    cache: "xg_cache",
    map: "xg_map",
    settings: "xg_settings",
    stats: "xg_stats",
    log: "xg_log",
    qid: "xg_qid",
    except: "xg_except",
    report: "xg_report",
  };

  const get = (k, d) => {
    try {
      const v = GM_getValue(k, undefined);
      if (v === undefined || v === null) return d;
      return typeof v === "string" ? JSON.parse(v) : v;
    } catch (e) {
      return d;
    }
  };
  const set = (k, v) => {
    try {
      GM_setValue(k, JSON.stringify(v));
    } catch (e) {}
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    autoUpdateHours: 6,
    blockMentions: false,
    blockProfile: true,
    pruneNetwork: true,
    removeMode: "remove",
    showButton: true,
    addButton: true,
    autoResolve: true,
    logLimit: 200,
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS, get(K.settings, {}));
  let sources = get(K.sources, null);
  if (!Array.isArray(sources) || !sources.length)
    sources = [{ url: DEFAULT_SOURCE, enabled: true, builtin: true }];
  let local = get(K.local, []);
  const except = get(K.except, []);
  let report = get(K.report, []);
  const cache = get(K.cache, {});
  for (const s of sources)
    if (s.builtin && LEGACY_SOURCES.includes(s.url)) {
      delete cache[s.url];
      s.url = DEFAULT_SOURCE;
    }
  let idMap = get(K.map, {});
  let stats = Object.assign({ tweets: 0, users: 0, api: 0 }, get(K.stats, {}));
  let logs = get(K.log, []);

  const saveSettings = () => set(K.settings, settings);
  const saveSources = () => set(K.sources, sources);
  const saveLocal = () => set(K.local, local);
  const saveExcept = () => set(K.except, except);
  const saveReport = () => set(K.report, report);
  const saveCache = () => set(K.cache, cache);
  const saveMap = () => set(K.map, idMap);
  let statsDirty = false;
  setInterval(() => {
    if (statsDirty) {
      set(K.stats, stats);
      statsDirty = false;
    }
  }, 3000);

  const bypass = new Set();

  const RE_ID = /^\d{5,25}$/;
  const RE_NAME = /^[A-Za-z0-9_]{1,15}$/;

  function parseLine(rawLine) {
    let s = String(rawLine || "").trim();
    if (!s || s.startsWith("#") || s.startsWith("//") || s.startsWith(";"))
      return null;
    s = s.split(/[#\t,]| \/\/ /)[0].trim();
    // 「1646... someuser」のような空白区切りも読む。ここで区切り文字に空白を
    // 足すと「username: someuser」の書き方を壊すので、前半が数値IDのときだけ切る
    const sp = /^(\d{5,25})\s+\S/.exec(s);
    if (sp) s = sp[1];
    if (!s) return null;
    let type = null;
    const pref =
      /^(id|userid|user_id|username|user|name|screen_name)\s*[:=]\s*(.+)$/i.exec(
        s,
      );
    if (pref) {
      const p = pref[1].toLowerCase();
      type = p === "id" || p === "userid" || p === "user_id" ? "id" : "name";
      s = pref[2].trim();
    }
    s = s
      .replace(/^https?:\/\/(mobile\.)?(x|twitter)\.com\//i, "")
      .replace(/^@+/, "")
      .replace(/\/.*$/, "")
      .trim();
    if (!s) return null;
    if (type === "id" || (!type && RE_ID.test(s)))
      return RE_ID.test(s) ? { type: "id", v: s } : null;
    if (!RE_NAME.test(s)) return null;
    return { type: "name", v: s.toLowerCase() };
  }

  const DELISTED = /^(delisted|removed|inactive|off)$/i;

  function parseSource(text) {
    const raw = String(text || ""),
      entries = [],
      map = Object.create(null),
      seen = new Set();
    const push = (e) => {
      if (!e) return;
      const k = e.type + ":" + e.v;
      if (seen.has(k)) return;
      seen.add(k);
      entries.push(e);
    };
    const pair = (id, name) => {
      const i = String(id || ""),
        n = String(name || "").replace(/^@+/, "");
      if (RE_ID.test(i) && RE_NAME.test(n)) map[i] = n;
    };
    const done = () => {
      let bare = 0;
      for (const e of entries) if (e.type === "id" && !map[e.v]) bare++;
      return {
        entries,
        map,
        bare,
        pairs: Object.keys(map).length,
      };
    };
    const t = raw.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        const j = JSON.parse(t);
        const arr = Array.isArray(j)
          ? j
          : j.accounts || j.users || j.entries || j.list || [];
        for (const a of arr) {
          if (!a) continue;
          if (typeof a === "string") {
            push(parseLine(a));
            continue;
          }
          if (DELISTED.test(a.status || "")) continue;
          const id = a.id || a.user_id || a.rest_id || a.id_str || "";
          const name = a.username || a.screen_name || a.handle || "";
          if (RE_ID.test(String(id))) {
            push({ type: "id", v: String(id) });
            pair(id, name);
          } else if (RE_NAME.test(String(name)))
            push({ type: "name", v: String(name).toLowerCase() });
        }
        return done();
      } catch (e) {}
    }
    const lines = raw.split(/\r?\n/);
    const head = (lines.find((l) => l.trim()) || "").trim();
    const cols = head
      .toLowerCase()
      .split(",")
      .map((c) => c.trim());
    const iId = cols.findIndex(
      (c) => c === "id" || c === "user_id" || c === "userid",
    );
    const iName = cols.findIndex(
      (c) => c === "username" || c === "screen_name" || c === "handle",
    );
    const iStatus = cols.indexOf("status");
    // 列名の行が1行あるなら、対応表として読めない形式でも本文として扱わない
    // （「user_id,note」を @user_id として登録してしまうのを防ぐ）
    const hasHeader = iId >= 0 || iName >= 0 || iStatus >= 0;
    if (iId >= 0 && iName >= 0) {
      for (const line of lines) {
        const s = line.trim();
        if (!s || s === head || /^[#;]/.test(s)) continue;
        const c = s.split(",").map((x) => x.trim());
        if (iStatus >= 0 && DELISTED.test(c[iStatus] || "")) continue;
        const id = c[iId] || "",
          nm = (c[iName] || "").replace(/^@+/, "");
        if (RE_ID.test(id)) {
          push({ type: "id", v: id });
          pair(id, nm);
        } else if (RE_NAME.test(nm))
          push({ type: "name", v: nm.toLowerCase() });
      }
      return done();
    }
    for (const line of lines) {
      if (hasHeader && line.trim() === head) continue;
      const e = parseLine(line);
      if (!e) continue;
      push(e);
      if (e.type !== "id") continue;
      // 2列目は理由・カテゴリ・件数のことがある。列名で保証がない以上、
      // @ で明示されたものだけ username として信用する。推測すると
      // 「1646...,spam」から @spam を消してしまう
      const m = /^[^#;]*?[,\t ]\s*@([A-Za-z0-9_]{1,15})\s*(?:[#;].*)?$/.exec(
        line.trim(),
      );
      if (m) pair(e.v, m[1]);
    }
    return done();
  }

  const parseText = (text) => parseSource(text).entries;

  const blockIds = new Set();
  const blockNames = new Set();

  const parsedCache = new Map();
  function parsedOf(url, text) {
    const c = parsedCache.get(url);
    if (c && c.text === text) return c.parsed;
    const parsed = parseSource(text);
    parsedCache.set(url, { text, parsed });
    return parsed;
  }

  let feedMap = Object.create(null);
  const resolvable = new Set();
  const nameOf = (id) => idMap[id] || feedMap[id] || "";

  const exceptIds = new Set(),
    exceptNames = new Set();

  function rebuild() {
    blockIds.clear();
    blockNames.clear();
    exceptIds.clear();
    exceptNames.clear();
    const add = (e) => {
      if (e.type === "id") blockIds.add(e.v);
      else blockNames.add(e.v);
    };
    for (const l of except) {
      const e = parseLine(l);
      if (!e) continue;
      if (e.type === "id") exceptIds.add(e.v);
      else exceptNames.add(e.v);
    }
    feedMap = Object.create(null);
    resolvable.clear();
    for (const src of sources) {
      const c = cache[src.url];
      const p = c && c.text ? parsedOf(src.url, c.text) : null;
      src.bare = p ? p.bare : 0;
      src.pairs = p ? p.pairs : 0;
      if (!src.enabled || !p) continue;
      p.entries.forEach(add);
      Object.assign(feedMap, p.map);
      if (src.resolve)
        for (const e of p.entries)
          if (e.type === "id" && !p.map[e.v]) resolvable.add(e.v);
    }
    for (const l of local) {
      const e = parseLine(l);
      if (!e) continue;
      add(e);
      if (e.type === "id") resolvable.add(e.v);
    }
    for (const id of [...blockIds]) {
      const n = nameOf(id);
      if (n) blockNames.add(n.toLowerCase());
    }
    for (const id of exceptIds) {
      blockIds.delete(id);
      const n = nameOf(id);
      if (n) blockNames.delete(n.toLowerCase());
    }
    for (const n of exceptNames) blockNames.delete(n);
    for (const t of bypass) {
      blockIds.delete(t);
      blockNames.delete(t.toLowerCase());
    }
    buildHints();
    seen = new WeakSet();
    scheduleScan();
    updateDash();
  }

  let hintRe = null;
  const SCAN_RE =
    /"(?:screen_name|rest_id|user_id_str|id_str)":"([A-Za-z0-9_]{1,25})"/g;

  function buildHints() {
    if (blockIds.size + blockNames.size > 200) {
      hintRe = null;
      return;
    }
    const parts = [];
    for (const id of blockIds) parts.push(id);
    for (const n of blockNames) parts.push('"' + n + '"');
    hintRe = parts.length ? new RegExp(parts.join("|"), "i") : null;
  }

  function rawHasBlocked(raw) {
    if (!blockIds.size && !blockNames.size) return false;
    if (hintRe) return hintRe.test(raw);
    SCAN_RE.lastIndex = 0;
    let m;
    while ((m = SCAN_RE.exec(raw))) {
      const v = m[1];
      if (blockIds.has(v) || blockNames.has(v.toLowerCase())) return true;
    }
    return false;
  }

  const unresolvedIds = () => [...blockIds].filter((id) => !nameOf(id));
  const pendingIds = () => unresolvedIds().filter((id) => resolvable.has(id));
  const needsResolveUI = () =>
    unresolvedIds().length > 0 ||
    Object.keys(idMap).length > 0 ||
    sources.some((s) => s.enabled && s.bare > 0);

  function httpGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: { "Cache-Control": "no-cache" },
        timeout: 20000,
        onload: (r) =>
          r.status >= 200 && r.status < 400
            ? resolve({ text: r.responseText, finalUrl: r.finalUrl || url })
            : reject(new Error("HTTP " + r.status)),
        onerror: () => reject(new Error("network error")),
        ontimeout: () => reject(new Error("timeout")),
      });
    });
  }

  async function refreshSource(src) {
    const r = await httpGet(
      src.url + (src.url.includes("?") ? "&" : "?") + "_=" + Date.now(),
    );
    const p = parseSource(r.text);
    cache[src.url] = { text: r.text, at: Date.now(), count: p.entries.length };
    src.bare = p.bare;
    src.pairs = p.pairs;
    saveCache();
    return p.entries.length;
  }

  function askResolve(src, after) {
    if (!src.bare || src.resolve !== undefined) {
      if (after) after();
      return;
    }
    confirmDialog(
      {
        title: "逆引きしますか？",
        desc:
          "このリストは user id だけで username の対応表を配っていません（" +
          src.bare +
          " 件）。x.com に問い合わせて username を逆引きしますか？逆引きしない場合、id 指定のアカウントは API 層でしか消せません。",
        ok: "逆引きする",
        no: "逆引きしない",
      },
      () => {
        src.resolve = true;
        saveSources();
        rebuild();
        resolveIds(50).then((n) => {
          if (n) toast(n + " 件解決しました");
          if (dash) renderTab();
        });
        if (after) after();
      },
      () => {
        src.resolve = false;
        saveSources();
        rebuild();
        if (after) after();
      },
    );
  }

  async function refreshAll(force, onProgress) {
    const now = Date.now();
    let ok = 0,
      ng = 0;
    const todo = sources.filter(
      (s) =>
        s.enabled &&
        (force ||
          !cache[s.url] ||
          now - (cache[s.url].at || 0) >= settings.autoUpdateHours * 3600e3),
    );
    for (const s of todo) {
      if (onProgress) onProgress(ok + ng, todo.length);
      try {
        await refreshSource(s);
        s.error = null;
        ok++;
      } catch (e) {
        ng++;
        s.error = String(e.message || e);
      }
    }
    if (onProgress) onProgress(ok + ng, todo.length);
    saveSources();
    rebuild();
    if (settings.autoResolve) resolveIds(30);
    return { ok, ng };
  }

  const auth = { bearer: "", csrf: "" };
  const FALLBACK_BEARER =
    "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  let queryId = get(K.qid, "") || "xvmVfRLmnr1alc5f2dib0Q";

  const cookie = (n) => {
    const m = new RegExp("(?:^|; )" + n + "=([^;]*)").exec(
      document.cookie || "",
    );
    return m ? decodeURIComponent(m[1]) : "";
  };

  const USER_FEATURES = {
    hidden_profile_subscriptions_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
  };

  async function findQueryId() {
    const srcs = [...document.querySelectorAll("script[src]")]
      .map((s) => s.src)
      .filter((u) => /client-web\/(main|api)\.[0-9a-f]+\.js/.test(u));
    for (const u of srcs) {
      try {
        const t = await W.fetch(u).then((r) => r.text());
        const m =
          /queryId:"([A-Za-z0-9_-]+)",operationName:"UserByRestId"/.exec(t);
        if (m) {
          queryId = m[1];
          set(K.qid, queryId);
          return queryId;
        }
      } catch (e) {}
    }
    return null;
  }

  async function apiUserById(id) {
    const url =
      "https://" +
      location.hostname +
      "/i/api/graphql/" +
      queryId +
      "/UserByRestId" +
      "?variables=" +
      encodeURIComponent(
        JSON.stringify({ userId: id, withSafetyModeUserFields: true }),
      ) +
      "&features=" +
      encodeURIComponent(JSON.stringify(USER_FEATURES));
    const res = await W.fetch(url, {
      credentials: "include",
      headers: {
        authorization: auth.bearer || FALLBACK_BEARER,
        "x-csrf-token": auth.csrf || cookie("ct0"),
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
      },
    });
    if (res.status === 404) return { retry: true };
    const j = await res.json().catch(() => null);
    const u = j && j.data && j.data.user && j.data.user.result;
    const sn =
      u &&
      ((u.core && u.core.screen_name) || (u.legacy && u.legacy.screen_name));
    return { name: sn || "", gone: !!(j && j.data && !sn) };
  }

  let resolving = false;
  async function resolveIds(limit, onProgress, all) {
    if (resolving) return 0;
    const targets = (all ? unresolvedIds() : pendingIds()).slice(
      0,
      limit || 20,
    );
    if (!targets.length) return 0;
    resolving = true;
    let n = 0,
      done = 0,
      refreshed = false;
    try {
      for (const id of targets) {
        if (onProgress) onProgress(done, targets.length);
        done++;
        try {
          let r = await apiUserById(id);
          if (r.retry && !refreshed) {
            refreshed = true;
            if (await findQueryId()) r = await apiUserById(id);
          }
          if (r.name) {
            idMap[id] = r.name;
            n++;
          } else if (r.gone) {
            idMap[id] = "";
          }
        } catch (e) {}
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      resolving = false;
      if (onProgress) onProgress(targets.length, targets.length);
      saveMap();
      rebuild();
    }
    return n;
  }

  let logTimer = 0;
  function pushLog(kind, who, where) {
    logs.unshift({ t: Date.now(), kind, who, where });
    if (logs.length > settings.logLimit) logs.length = settings.logLimit;
    if (logs.length % 5 === 0 || logs.length < 5) set(K.log, logs);
    if (dash && dash.tab === "log" && !logTimer)
      logTimer = setTimeout(() => {
        logTimer = 0;
        if (dash && dash.tab === "log") renderTab();
      }, 400);
  }

  const USER_ID_KEYS = new Set(["user_id_str", "userId", "user_id", "rest_id"]);

  function harvest(obj) {
    let changed = false;
    const walk = (n, d) => {
      if (!n || d > 24 || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (const v of n) walk(v, d + 1);
        return;
      }
      const id = n.rest_id || n.id_str || (n.legacy && n.legacy.id_str);
      if (id && blockIds.has(String(id)) && !nameOf(id)) {
        const sn =
          n.screen_name ||
          (n.core && n.core.screen_name) ||
          (n.legacy && n.legacy.screen_name);
        if (sn && RE_NAME.test(String(sn))) {
          idMap[id] = sn;
          changed = true;
        }
      }
      for (const k in n) {
        const v = n[k];
        if (v && typeof v === "object") walk(v, d + 1);
      }
    };
    try {
      walk(obj, 0);
    } catch (e) {}
    if (changed) {
      saveMap();
      rebuild();
    }
    return changed;
  }

  function jsonHasBlocked(n, d) {
    if (!n || typeof n !== "object" || d > 24) return false;
    if (Array.isArray(n)) {
      for (const v of n) if (jsonHasBlocked(v, d + 1)) return true;
      return false;
    }
    const sn =
      n.screen_name ||
      (n.core && n.core.screen_name) ||
      (n.legacy && n.legacy.screen_name);
    if (sn && blockNames.has(String(sn).toLowerCase())) return true;
    if (sn) {
      const id = n.rest_id || n.id_str || (n.legacy && n.legacy.id_str);
      if (id && blockIds.has(String(id))) return true;
    }
    for (const k in n) {
      const v = n[k];
      if (
        !settings.blockMentions &&
        (k === "user_mentions" || k === "mentions")
      )
        continue;
      if (typeof v === "string" || typeof v === "number") {
        if (
          USER_ID_KEYS.has(k) &&
          blockIds.has(String(v)) &&
          (k !== "rest_id" || n.__typename === "User" || sn)
        )
          return true;
      } else if (v && typeof v === "object") {
        if (jsonHasBlocked(v, d + 1)) return true;
      }
    }
    return false;
  }

  const isEntryLike = (el) =>
    !!(
      el &&
      typeof el === "object" &&
      (typeof el.entryId === "string" ||
        el.itemContent ||
        (el.item && el.item.itemContent) ||
        el.tweet_results ||
        el.user_results)
    );

  function pruneJson(n, d) {
    if (!n || typeof n !== "object" || d > 24) return 0;
    let removed = 0;
    if (Array.isArray(n)) {
      for (let i = n.length - 1; i >= 0; i--) {
        const el = n[i];
        if (
          el &&
          typeof el === "object" &&
          isEntryLike(el) &&
          jsonHasBlocked(el, 0)
        ) {
          n.splice(i, 1);
          removed++;
        } else removed += pruneJson(el, d + 1);
      }
      return removed;
    }
    for (const k in n) removed += pruneJson(n[k], d + 1);
    return removed;
  }

  const API_RE =
    /\/i\/api\/|\/graphql\/|\/1\.1\/|\/2\/(timeline|search|notifications)/;
  const shortUrl = (u) => {
    try {
      const p = new URL(u, location.href).pathname.split("/");
      return p[p.length - 1] || u;
    } catch (e) {
      return u;
    }
  };

  function processBody(raw, url) {
    if (typeof raw !== "string" || raw.length < 2) return raw;
    if (!settings.enabled || !settings.pruneNetwork) return raw;
    if (raw[0] !== "{" && raw[0] !== "[") return raw;
    if (!rawHasBlocked(raw)) return raw;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return raw;
    }
    harvest(obj);
    let removed = 0;
    try {
      removed = pruneJson(obj, 0);
    } catch (e) {
      return raw;
    }
    if (!removed) return raw;
    stats.api += removed;
    statsDirty = true;
    pushLog("api", removed + "件", shortUrl(url));
    try {
      return JSON.stringify(obj);
    } catch (e) {
      return raw;
    }
  }

  function hookXHR() {
    const P = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
    if (!P) return;
    const rt = Object.getOwnPropertyDescriptor(P, "responseText");
    const rp = Object.getOwnPropertyDescriptor(P, "response");
    const open = P.open,
      send = P.send,
      srh = P.setRequestHeader;
    if (!rt || !rt.get) return;

    P.open = function (_method, u) {
      this.__xgUrl = String(u || "");
      return open.apply(this, arguments);
    };

    P.setRequestHeader = function (k, v) {
      const kk = String(k).toLowerCase();
      if (kk === "authorization" && /^Bearer /i.test(String(v)))
        auth.bearer = String(v);
      else if (kk === "x-csrf-token") auth.csrf = String(v);
      return srh.apply(this, arguments);
    };

    P.send = function () {
      const url = this.__xgUrl || "";
      if (API_RE.test(url)) {
        const xhr = this;
        let rawCache = null,
          outCache = null,
          objCache = null;
        const proc = (raw) => {
          if (raw === rawCache) return outCache;
          rawCache = raw;
          outCache = processBody(raw, url);
          return outCache;
        };
        try {
          Object.defineProperty(xhr, "responseText", {
            configurable: true,
            get() {
              try {
                return proc(rt.get.call(xhr));
              } catch (e) {
                return "";
              }
            },
          });
          if (rp && rp.get) {
            Object.defineProperty(xhr, "response", {
              configurable: true,
              get() {
                let v;
                try {
                  v = rp.get.call(xhr);
                } catch (e) {
                  return null;
                }
                if (typeof v === "string") return proc(v);
                if (
                  v &&
                  typeof v === "object" &&
                  settings.enabled &&
                  settings.pruneNetwork &&
                  (blockIds.size || blockNames.size) &&
                  !(v instanceof W.Blob) &&
                  !(v instanceof W.ArrayBuffer)
                ) {
                  if (v !== objCache) {
                    objCache = v;
                    try {
                      harvest(v);
                      const n = pruneJson(v, 0);
                      if (n) {
                        stats.api += n;
                        statsDirty = true;
                        pushLog("api", n + "件", shortUrl(url));
                      }
                    } catch (e) {}
                  }
                }
                return v;
              },
            });
          }
        } catch (e) {}
      }
      return send.apply(this, arguments);
    };
  }

  function hookFetch() {
    const orig = W.fetch;
    if (typeof orig !== "function") return;
    W.fetch = function (...args) {
      const p = orig.apply(this, args);
      let url = "";
      try {
        const a = args[0];
        url = typeof a === "string" ? a : (a && a.url) || "";
      } catch (e) {}
      if (!url || !API_RE.test(url) || url.includes("UserByRestId")) return p;
      return p.then(async (res) => {
        try {
          if (
            !/json/i.test(
              (res.headers && res.headers.get("content-type")) || "",
            )
          )
            return res;
          const raw = await res.clone().text();
          const out = processBody(raw, url);
          if (out === raw) return res;
          return new W.Response(out, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        } catch (e) {
          return res;
        }
      });
    };
  }

  hookXHR();
  hookFetch();

  const RESERVED = new Set([
    "i",
    "home",
    "explore",
    "search",
    "notifications",
    "messages",
    "settings",
    "compose",
    "hashtag",
    "intent",
    "login",
    "logout",
    "signup",
    "about",
    "tos",
    "privacy",
    "account",
    "following",
    "followers",
    "topics",
    "lists",
    "bookmarks",
    "jobs",
    "status",
    "share",
    "widgets",
    "download",
    "help",
    "x",
    "twitter",
  ]);

  function handlesIn(el) {
    const out = new Set();
    let links;
    try {
      links = el.querySelectorAll('a[href^="/"]');
    } catch (e) {
      return out;
    }
    for (const a of links) {
      if (!settings.blockMentions && a.closest('[data-testid="tweetText"]'))
        continue;
      const href = a.getAttribute("href") || "";
      const idm = /^\/i\/user\/(\d+)/.exec(href);
      if (idm) {
        out.add("\u0000" + idm[1]);
        continue;
      }
      const m = /^\/([A-Za-z0-9_]{1,15})(?:$|[/?#])/.exec(href);
      if (!m) continue;
      const n = m[1].toLowerCase();
      if (!RESERVED.has(n)) out.add(n);
    }
    return out;
  }

  function hitOf(el) {
    const hs = handlesIn(el);
    for (const h of hs) {
      if (h[0] === "\u0000") {
        if (blockIds.has(h.slice(1))) return h.slice(1);
        continue;
      }
      if (blockNames.has(h)) return "@" + h;
    }
    return hs.size ? null : undefined;
  }

  function kill(el, kind, who) {
    if (!el || !el.isConnected) return false;
    try {
      if (settings.removeMode === "hide") {
        el.style.setProperty("display", "none", "important");
        el.setAttribute("data-xgomi", "1");
      } else el.remove();
    } catch (e) {
      return false;
    }
    if (kind === "user") stats.users++;
    else stats.tweets++;
    statsDirty = true;
    pushLog(kind, who || "?", location.pathname);
    return true;
  }

  function container(el) {
    const cell = el.closest('[data-testid="cellInnerDiv"]');
    if (cell) {
      if (
        el.matches('[data-testid="UserCell"]') &&
        cell.querySelectorAll('[data-testid="UserCell"]').length > 1
      )
        return el;
      if (el.matches("article") && cell.querySelectorAll("article").length > 1)
        return el;
      return cell;
    }
    const li = el.closest(
      'li[role="listitem"], div[role="listitem"], div[role="option"]',
    );
    return li || el;
  }

  const CANDIDATES = [
    'article[data-testid="tweet"]',
    'article[role="article"]',
    '[data-testid="cellInnerDiv"]',
    '[data-testid="UserCell"]',
    '[data-testid="tweet"]',
    'div[role="option"]',
    '[data-testid="typeaheadResult"]',
    'li[role="listitem"]',
    '[data-testid="HoverCard"]',
  ].join(",");

  let seen = new WeakSet();

  function sweep(root) {
    const base = root && root.nodeType === 1 ? root : document;
    injectAll(base);
    if (!settings.enabled || (!blockNames.size && !blockIds.size)) {
      blockProfilePage();
      return;
    }
    let nodes;
    try {
      nodes = base.querySelectorAll(CANDIDATES);
    } catch (e) {
      return;
    }
    const list =
      base !== document && base.matches && base.matches(CANDIDATES)
        ? [base, ...nodes]
        : nodes;
    for (const el of list) {
      if (
        seen.has(el) ||
        !el.isConnected ||
        (el.getAttribute && el.getAttribute("data-xgomi"))
      )
        continue;
      if (
        el.matches('[data-testid="cellInnerDiv"]') &&
        (el.querySelectorAll('[data-testid="UserCell"]').length > 1 ||
          el.querySelectorAll("article").length > 1)
      )
        continue;
      const who = hitOf(el);
      if (!who) {
        if (who === null) seen.add(el);
        continue;
      }
      const isUser = !!(
        el.matches('[data-testid="UserCell"]') ||
        el.querySelector('[data-testid="UserCell"]')
      );
      const target = container(el);
      kill(
        target,
        isUser && !target.querySelector("article") ? "user" : "tweet",
        who,
      );
    }
    blockProfilePage();
  }

  const ADD_ICON =
    '<g><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zM7 11h10v2H7z"></path></g>';
  const UNDO_ICON =
    '<g><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zM7 11h10v2H7zm4-4h2v10h-2z"></path></g>';

  function authorOf(el) {
    let links;
    try {
      links = el.querySelectorAll('[data-testid="User-Name"] a[href^="/"]');
    } catch (e) {
      return "";
    }
    for (const a of links) {
      const m = /^\/([A-Za-z0-9_]{1,15})$/.exec(a.getAttribute("href") || "");
      if (m && !RESERVED.has(m[1].toLowerCase())) return m[1];
    }
    return "";
  }

  let menuTarget = null;

  function watchCaret() {
    document.addEventListener(
      "pointerdown",
      (e) => {
        const t = e.target;
        const caret =
          t && t.closest ? t.closest('[data-testid="caret"]') : null;
        const article = caret && caret.closest("article");
        const name = article ? authorOf(article) : "";
        menuTarget = name ? { name, article, at: Date.now() } : null;
      },
      true,
    );
  }

  function closeNativeMenu() {
    const mask = document.querySelector('[data-testid="mask"]');
    if (mask) {
      mask.click();
      return;
    }
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        keyCode: 27,
        bubbles: true,
      }),
    );
  }

  function injectMenuItem(menu) {
    if (!settings.addButton || menu.querySelector("[data-xgomi-item]")) return;
    const target = menuTarget;
    if (!target || Date.now() - target.at > 5000 || !target.article.isConnected)
      return;
    const tpl =
      menu.querySelector('div[role="menuitem"][data-testid="block"]') ||
      menu.querySelector('div[role="menuitem"]');
    if (!tpl) return;
    const name = target.name;
    const listed = local.includes("username:" + name.toLowerCase());
    const item = tpl.cloneNode(true);
    item.removeAttribute("data-testid");
    item.setAttribute("data-xgomi-item", name);
    const svg = item.querySelector("svg");
    if (svg) svg.innerHTML = listed ? UNDO_ICON : ADD_ICON;
    const span = item.querySelector("span") || item;
    span.textContent = listed
      ? "@" + name + " をxgomiから外す"
      : "@" + name + " をxgomiで消す";
    item.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeNativeMenu();
        if (listed) {
          confirmDialog(
            {
              title: "xgomiから外しますか？",
              desc:
                "@" +
                name +
                " の投稿がタイムラインや検索に再び表示されるようになります。",
              ok: "外す",
            },
            () => undoAdd(name),
          );
          return;
        }
        confirmDialog(
          {
            title: "xgomiで消しますか？",
            desc:
              "@" +
              name +
              " の投稿を、タイムライン・検索・返信などあらゆる場所から非表示にします。いつでも元に戻せます。",
            ok: "消す",
            danger: true,
          },
          () => addFromPost(name, target.article),
        );
      },
      true,
    );
    const anchor = tpl.getAttribute("data-testid") === "block" ? tpl : null;
    if (anchor && anchor.nextSibling)
      anchor.parentElement.insertBefore(item, anchor.nextSibling);
    else (tpl.parentElement || menu).appendChild(item);
  }

  function injectAll(base) {
    if (!settings.addButton) return;
    let menus;
    try {
      menus =
        base.matches && base.matches('[role="menu"]')
          ? [base, ...base.querySelectorAll('[role="menu"]')]
          : base.querySelectorAll('[role="menu"]');
    } catch (e) {
      return;
    }
    for (const m of menus) injectMenuItem(m);
  }

  function addFromPost(name, article) {
    const key = "username:" + name.toLowerCase();
    if (!local.includes(key)) {
      local.push(key);
      saveLocal();
    }
    const link = article.querySelector('a[href*="/status/"]');
    const href = link ? link.getAttribute("href") || "" : "";
    const m = /^\/[A-Za-z0-9_]{1,15}\/status\/\d+/.exec(href);
    if (!report.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      report.push({
        name,
        url: m ? "https://x.com" + m[0] : "",
        at: Date.now(),
      });
      saveReport();
    }
    rebuild();
    toast("@" + name + " を追加", "取り消す", () => undoAdd(name));
  }

  function undoAdd(name) {
    const i = local.indexOf("username:" + name.toLowerCase());
    if (i >= 0) {
      local.splice(i, 1);
      saveLocal();
    }
    const j = report.findIndex(
      (r) => r.name.toLowerCase() === name.toLowerCase(),
    );
    if (j >= 0) {
      report.splice(j, 1);
      saveReport();
    }
    rebuild();
    toast("@" + name + " の追加を取り消しました");
  }

  let scanQueued = false,
    scanRoots = [],
    scanAll = false;
  function scheduleScan(root) {
    if (root && root.nodeType === 1 && scanRoots.length < 64)
      scanRoots.push(root);
    else scanAll = true;
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      const roots = scanRoots,
        all = scanAll;
      scanRoots = [];
      scanAll = false;
      try {
        if (all) sweep(document);
        else for (const r of roots) if (r.isConnected) sweep(r);
      } catch (e) {}
    });
  }

  function startObserver() {
    new MutationObserver((recs) => {
      for (const r of recs)
        for (const n of r.addedNodes) if (n.nodeType === 1) scheduleScan(n);
    }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => scheduleScan(), 2000);
  }

  const PALETTES = {
    light: {
      bg: "#ffffff",
      panel: "#f7f9f9",
      border: "#eff3f4",
      text: "#0f1419",
      muted: "#536471",
      hover: "rgba(15,20,25,.1)",
      btnText: "#ffffff",
      btnBorder: "#cfd9de",
      shadow:
        "rgba(101,119,134,.2) 0 0 15px, rgba(101,119,134,.15) 0 0 3px 1px",
    },
    dim: {
      bg: "#15202b",
      panel: "#1e2732",
      border: "#38444d",
      text: "#f7f9f9",
      muted: "#8b98a5",
      hover: "rgba(247,249,249,.1)",
      btnText: "#0f1419",
      btnBorder: "#5c6e7e",
      shadow:
        "rgba(136,153,166,.2) 0 0 15px, rgba(136,153,166,.15) 0 0 3px 1px",
    },
    dark: {
      bg: "#000000",
      panel: "#16181c",
      border: "#2f3336",
      text: "#e7e9ea",
      muted: "#71767b",
      hover: "rgba(231,233,234,.1)",
      btnText: "#0f1419",
      btnBorder: "#536471",
      shadow:
        "rgba(255,255,255,.2) 0 0 15px, rgba(255,255,255,.15) 0 0 3px 1px",
    },
  };

  function chromatic(c) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || "");
    if (!m) return false;
    const r = +m[1],
      g = +m[2],
      b = +m[3];
    return Math.max(r, g, b) - Math.min(r, g, b) > 40;
  }

  function palette() {
    let bg = "";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) bg = (meta.content || "").toLowerCase();
    if (!bg && document.body)
      bg = getComputedStyle(document.body).backgroundColor;
    let p = PALETTES.dark;
    if (/#ffffff|255,\s*255,\s*255/.test(bg)) p = PALETTES.light;
    else if (/#15202b|21,\s*32,\s*43/.test(bg)) p = PALETTES.dim;
    let accent = "#1d9bf0";
    try {
      for (const sel of [
        '[data-testid="tweetText"] a',
        'a[href^="/hashtag/"]',
        '[data-testid="trend"] a',
        'main a[role="link"][style*="rgb"]',
      ]) {
        const a = document.querySelector(sel);
        if (!a) continue;
        const c = getComputedStyle(a).color;
        if (chromatic(c)) {
          accent = c;
          break;
        }
      }
    } catch (e) {}
    let font =
      '"TwitterChirp", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    try {
      if (document.body)
        font = getComputedStyle(document.body).fontFamily + ", " + font;
    } catch (e) {}
    return Object.assign({ accent, font }, p);
  }

  const CSS = `
:host{all:initial}
*{box-sizing:border-box;margin:0;padding:0;font-family:var(--f)}
.ov{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:2147483646;display:flex;align-items:center;justify-content:center;animation:fade .1s ease}
.win{width:min(600px,100vw);height:min(680px,100vh);background:var(--bg);color:var(--tx);border-radius:16px;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--sh);animation:pop .12s cubic-bezier(.2,.8,.2,1)}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes pop{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:none}}
@keyframes slideup{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes spin{to{transform:rotate(360deg)}}
@media (max-width:620px){.win{border-radius:0}}
.hd{display:flex;align-items:center;gap:20px;height:53px;padding:0 16px;flex:0 0 auto}
.ic{width:34px;height:34px;border-radius:9999px;border:0;background:transparent;color:var(--tx);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:19px;line-height:1}
.ic:hover{background:var(--hv)}
.ti{font-size:20px;font-weight:800;flex:1}
.tabs{display:flex;border-bottom:1px solid var(--bd);flex:0 0 auto}
.tab{flex:1;height:53px;display:flex;align-items:center;justify-content:center;position:relative;cursor:pointer;color:var(--mu);font-size:15px;font-weight:500;background:transparent;border:0;white-space:nowrap}
.tab:hover{background:var(--hv)}
.tab.on{color:var(--tx);font-weight:700}
.tab::after{content:"";position:absolute;bottom:0;left:50%;width:70%;max-width:60px;height:4px;border-radius:9999px;background:var(--ac);transform:translateX(-50%) scaleX(0);opacity:0;transition:transform .18s cubic-bezier(.2,.8,.2,1),opacity .18s ease}
.tab.on::after{transform:translateX(-50%) scaleX(1);opacity:1}
.bd{flex:1;overflow-y:auto;overscroll-behavior:contain}
.sec{border-bottom:1px solid var(--bd)}
.sh{padding:12px 16px 4px;font-size:20px;font-weight:800}
.row{display:flex;align-items:center;gap:12px;padding:12px 16px;min-height:52px}
.row.cl{cursor:pointer}
.row.cl:hover{background:var(--hv)}
.row .gr{flex:1;min-width:0}
.row .t{font-size:15px;font-weight:400;color:var(--tx)}
.row .d{font-size:13px;color:var(--mu);margin-top:2px;line-height:1.4}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.mu{color:var(--mu)}
.grid{display:grid;grid-template-columns:repeat(3,1fr)}
.st{padding:14px 16px;border-right:1px solid var(--bd);border-bottom:1px solid var(--bd)}
.st .n{font-size:20px;font-weight:800}
.st .l{font-size:13px;color:var(--mu);margin-top:2px}
.btn{height:34px;padding:0 16px;border-radius:9999px;border:1px solid transparent;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:background .1s ease,filter .1s ease,transform .08s ease}
.btn:active:not([disabled]){transform:scale(.96)}
.sp{width:14px;height:14px;border-radius:9999px;border:2px solid currentColor;border-top-color:transparent;animation:spin .7s linear infinite;flex:0 0 auto}
.tab:focus-visible,.btn:focus-visible,.sw:focus-visible,.rd:focus-visible,.ic:focus-visible,.tf:focus-visible,.row.cl:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
.bar.busy{cursor:progress}
.btn.p{background:var(--tx);color:var(--bt)}
.btn.p:hover{opacity:.9}
.btn.o{background:transparent;color:var(--tx);border-color:var(--bo)}
.btn.o:hover{background:var(--hv)}
.btn.a{background:var(--ac);color:#fff}
.btn.a:hover{filter:brightness(.92)}
.btn.d{background:transparent;color:#f4212e;border-color:rgba(244,33,46,.4)}
.btn.d:hover{background:rgba(244,33,46,.1)}
.btn[disabled]{cursor:default}
.btn[disabled]:not([aria-busy]){background:transparent;color:var(--mu);border-color:var(--bd);filter:none}
.btn[aria-busy]{opacity:.75}
.btn.sm{height:30px;padding:0 12px;font-size:13px}
.sw{width:44px;height:24px;border-radius:9999px;background:transparent;border:2px solid var(--mu);position:relative;flex:0 0 auto;cursor:pointer;transition:background .2s ease,border-color .2s ease}
.sw i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:9999px;background:var(--mu);transition:transform .2s cubic-bezier(.2,.8,.2,1),background .2s ease}
.sw.on{background:var(--ac);border-color:var(--ac)}
.sw.on i{transform:translateX(20px);background:#fff}
.row.cl:hover .sw{border-color:var(--tx)}
.row.cl:hover .sw.on{border-color:var(--ac)}
.row.of,.rd.of{cursor:default}
.row.of:hover,.rd.of:hover{background:transparent}
.row.of .t,.row.of .d,.rd.of .t,.rd.of .d{color:var(--mu)}
.row.of .sw,.row.of:hover .sw{background:transparent;border-color:var(--bd)}
.row.of .sw i{background:var(--bd)}
.rd.of .c{border-color:var(--bd)}
.rd.of.on .c::after{background:var(--bd)}
.tf{width:100%;background:transparent;border:1px solid var(--bo);border-radius:4px;padding:11px 12px;color:var(--tx);font-size:15px;outline:none}
.tf::placeholder{color:var(--mu)}
.tf:focus{border-color:var(--ac)}
textarea.tf{min-height:96px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.bar{display:flex;gap:8px;padding:12px 16px;flex-wrap:wrap;align-items:center}
.it{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--bd)}
.it:hover{background:var(--hv)}
.it .gr{flex:1;min-width:0;overflow:hidden}
.it .a{font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.it .b{font-size:13px;color:var(--mu);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.em{padding:32px 24px;text-align:center;color:var(--mu);font-size:15px}
.rd{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer}
.rd:hover{background:var(--hv)}
.rd .c{width:20px;height:20px;border-radius:9999px;border:2px solid var(--mu);flex:0 0 auto;position:relative}
.rd.on .c{border-color:var(--ac)}
.rd.on .c::after{content:"";position:absolute;inset:3px;border-radius:9999px;background:var(--ac)}
.fab{position:fixed;left:12px;bottom:12px;z-index:2147483645;height:32px;padding:0 14px;border-radius:9999px;border:1px solid var(--bo);background:var(--bg);color:var(--tx);font-size:13px;font-weight:700;cursor:pointer;font-family:var(--f)}
.fab:hover{background:var(--hv)}
.fab.off{color:#f4212e;border-color:rgba(244,33,46,.6)}
.warn{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--bd);background:rgba(244,33,46,.1)}
.warn .t{font-size:15px;font-weight:700;color:#f4212e}
.warn .d{font-size:13px;color:var(--mu);margin-top:2px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}.sp{animation:spin 1.2s linear infinite!important}}
`;

  const vars = (p) =>
    `--bg:${p.bg};--tx:${p.text};--mu:${p.muted};--bd:${p.border};--bo:${p.btnBorder};--hv:${p.hover};--ac:${p.accent};--bt:${p.btnText};--sh:${p.shadow};--f:${p.font};`;

  let dash = null;

  function h(tag, attrs, ...kids) {
    const e = typeof tag === "string" ? document.createElement(tag) : tag;
    if (attrs)
      for (const k in attrs) {
        const v = attrs[k];
        if (k === "cls") e.className = v;
        else if (k.startsWith("on")) e[k] = v;
        else if (v !== null && v !== undefined && v !== false)
          e.setAttribute(k, v === true ? "" : v);
      }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      e.appendChild(
        typeof kid === "object" ? kid : document.createTextNode(String(kid)),
      );
    }
    return e;
  }

  const announce = (msg) => {
    if (dash) dash.live.textContent = msg;
  };

  async function busy(btn, label, fn) {
    const prev = btn.textContent;
    const tx = h("span", null, label);
    btn.textContent = "";
    btn.append(h("span", { cls: "sp" }), tx);
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    if (btn.parentElement) btn.parentElement.classList.add("busy");
    announce(label);
    const progress = (done, total) => {
      const s = total > 1 ? `${label} ${done}/${total}` : label;
      tx.textContent = s;
      announce(s);
    };
    try {
      return await fn(progress);
    } finally {
      if (btn.parentElement) btn.parentElement.classList.remove("busy");
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  const fmtTime = (t) => {
    if (!t) return "未取得";
    const d = new Date(t),
      p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function openDash() {
    if (dash) {
      dash.host.style.display = "";
      applyTheme();
      renderTab();
      focusDash();
      return;
    }
    const host = h("div");
    host.style.cssText = "all:initial";
    const sr = host.attachShadow({ mode: "open" });
    const style = h("style");
    style.textContent = CSS;
    sr.appendChild(style);
    const body = h("div", { cls: "bd", role: "tabpanel", tabindex: "0" });
    const tabsEl = h("div", { cls: "tabs", role: "tablist" });
    const live = h("div", {
      cls: "sr",
      role: "status",
      "aria-live": "polite",
    });
    const win = h(
      "div",
      {
        cls: "win",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "xgomi ダッシュボード",
      },
      live,
      h(
        "div",
        { cls: "hd" },
        h(
          "button",
          { cls: "ic", title: "閉じる", onclick: closeDash },
          "\u2715",
        ),
        h("div", { cls: "ti" }, "xgomi"),
        h(
          "button",
          {
            cls: "btn p",
            id: "toggle",
            onclick: () => {
              settings.enabled = !settings.enabled;
              saveSettings();
              rebuild();
              scheduleScan();
              renderTab();
            },
          },
          "",
        ),
      ),
      tabsEl,
      body,
    );
    const ov = h(
      "div",
      {
        cls: "ov",
        onclick: (e) => {
          if (e.target === ov) closeDash();
        },
      },
      win,
    );
    sr.appendChild(ov);
    (document.body || document.documentElement).appendChild(host);
    dash = { host, sr, ov, body, tabsEl, live, tab: "overview" };
    applyTheme();
    renderTabs();
    renderTab();
    focusDash();
    document.addEventListener("keydown", escClose, true);
  }

  function focusDash() {
    const t = dash && dash.sr.querySelector(".tab.on");
    if (t) t.focus({ preventScroll: true });
  }

  function applyTheme() {
    const p = palette();
    if (dash) dash.ov.setAttribute("style", vars(p));
    if (fab) fab.el.setAttribute("style", vars(p));
  }

  const escClose = (e) => {
    if (e.key === "Escape" && dash && dash.host.style.display !== "none")
      closeDash();
  };
  const closeDash = () => {
    if (!dash || dash.host.style.display === "none") return;
    dash.host.style.display = "none";
    if (fab) fab.el.focus({ preventScroll: true });
  };

  const TABS = [
    ["overview", "概要"],
    ["list", "リスト"],
    ["sources", "ソース"],
    ["ids", "ID"],
    ["settings", "設定"],
    ["log", "ログ"],
  ];

  const visibleTabs = () =>
    TABS.filter(([id]) => id !== "ids" || needsResolveUI());

  function renderTabs() {
    dash.tabsEl.textContent = "";
    const tabs = visibleTabs();
    dash.tabsKey = tabs.map(([id]) => id).join();
    if (!tabs.some(([id]) => id === dash.tab)) dash.tab = "overview";
    for (const [id, label] of tabs) {
      dash.tabsEl.appendChild(
        h(
          "button",
          {
            cls: "tab" + (dash.tab === id ? " on" : ""),
            role: "tab",
            "aria-selected": dash.tab === id ? "true" : "false",
            onclick: () => {
              dash.tab = id;
              renderTabs();
              renderTab();
            },
            onkeydown: (e) => {
              const i = tabs.findIndex(([x]) => x === dash.tab);
              const d =
                e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!d) return;
              e.preventDefault();
              dash.tab = tabs[(i + d + tabs.length) % tabs.length][0];
              renderTabs();
              renderTab();
              focusDash();
            },
          },
          label,
        ),
      );
    }
  }

  let renderLock = 0;
  const updateDash = () => {
    if (!renderLock && dash && dash.host.style.display !== "none") renderTab();
  };

  function updateToggleBtn() {
    const t = dash && dash.sr.querySelector("#toggle");
    if (t) {
      t.textContent = settings.enabled ? "有効" : "停止中";
      t.className = "btn " + (settings.enabled ? "p" : "d");
    }
    updateFab();
  }

  function renderTab() {
    if (!dash) return;
    updateToggleBtn();
    if (
      visibleTabs()
        .map(([id]) => id)
        .join() !== dash.tabsKey
    )
      renderTabs();
    dash.body.textContent = "";
    ({
      overview: tabOverview,
      list: tabList,
      sources: tabSources,
      ids: tabIds,
      settings: tabSettings,
      log: tabLog,
    })[dash.tab](dash.body);
  }

  const stat = (n, l) =>
    h(
      "div",
      { cls: "st" },
      h("div", { cls: "n" }, String(n)),
      h("div", { cls: "l" }, l),
    );

  function switchRow(key, title, desc, onChange, dep) {
    const off = dep && !settings.enabled;
    const sw = h(
      "div",
      { cls: "sw" + (settings[key] && !off ? " on" : "") },
      h("i"),
    );
    const flip = () => {
      if (off) {
        toast("「有効」がオフのため変更できません", "有効にする", () => {
          settings.enabled = true;
          saveSettings();
          renderTab();
          updateToggleBtn();
          renderLock++;
          try {
            rebuild();
            scheduleScan();
          } finally {
            renderLock--;
          }
        });
        return;
      }
      settings[key] = !settings[key];
      saveSettings();
      sw.className = "sw" + (settings[key] ? " on" : "");
      row.setAttribute("aria-checked", settings[key] ? "true" : "false");
      renderLock++;
      try {
        rebuild();
        scheduleScan();
      } finally {
        renderLock--;
      }
      updateToggleBtn();
      announce(title + (settings[key] ? " オン" : " オフ"));
      if (onChange) onChange();
    };
    const row = h(
      "div",
      {
        cls: "row cl" + (off ? " of" : ""),
        role: "switch",
        tabindex: "0",
        "aria-checked": settings[key] ? "true" : "false",
        "aria-disabled": off ? "true" : null,
        onclick: flip,
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            flip();
          }
        },
      },
      h(
        "div",
        { cls: "gr" },
        h("div", { cls: "t" }, title),
        desc ? h("div", { cls: "d" }, desc) : null,
      ),
      sw,
    );
    return row;
  }

  function tabOverview(b) {
    if (!settings.enabled) {
      b.appendChild(
        h(
          "div",
          { cls: "warn" },
          h(
            "div",
            { cls: "gr" },
            h("div", { cls: "t" }, "停止中"),
            h(
              "div",
              { cls: "d" },
              "除去処理はすべて止まっています。ブロック対象も普通に表示されます。",
            ),
          ),
          h(
            "button",
            {
              cls: "btn p",
              onclick: () => {
                settings.enabled = true;
                saveSettings();
                toggleFab();
                rebuild();
                scheduleScan();
                renderTab();
              },
            },
            "有効にする",
          ),
        ),
      );
    }
    const lastAt = Math.max(
      0,
      ...sources.map((s) => (cache[s.url] || {}).at || 0),
    );
    b.appendChild(
      h(
        "div",
        { cls: "grid" },
        stat(blockNames.size, "username"),
        stat(blockIds.size, "user id"),
        needsResolveUI() ? stat(unresolvedIds().length, "未解決 id") : null,
        stat(stats.api, "API段階で除去"),
        stat(stats.tweets, "削除した投稿"),
        stat(stats.users, "削除したユーザー"),
      ),
    );
    b.appendChild(
      h(
        "div",
        { cls: "bar" },
        h(
          "button",
          {
            cls: "btn a",
            onclick: async (e) => {
              const r = await busy(e.currentTarget, "更新中", (p) =>
                refreshAll(true, p),
              );
              renderTab();
              toast(`更新: 成功 ${r.ok} / 失敗 ${r.ng}`);
            },
          },
          "リスト更新",
        ),
        needsResolveUI()
          ? h(
              "button",
              {
                cls: "btn o",
                onclick: async (e) => {
                  const n = await busy(e.currentTarget, "解決中", (p) =>
                    resolveIds(50, p, true),
                  );
                  renderTab();
                  toast(
                    n
                      ? `${n} 件解決しました`
                      : "解決できる id はありませんでした",
                  );
                },
              },
              "ID解決",
            )
          : null,
        h(
          "button",
          {
            cls: "btn o",
            onclick: () => {
              const before = stats.tweets + stats.users;
              sweep(document);
              renderTab();
              const n = stats.tweets + stats.users - before;
              toast(n ? `${n} 件除去しました` : "このページに対象はありません");
            },
          },
          "再スキャン",
        ),
      ),
    );
    b.appendChild(
      h(
        "div",
        { cls: "row" },
        h(
          "div",
          { cls: "gr" },
          h("div", { cls: "t" }, "最終取得"),
          h("div", { cls: "d" }, fmtTime(lastAt)),
        ),
      ),
    );
  }

  const ISSUE_BASE = "https://github.com/mikumiku-jp/xgomi/issues/new";
  const ROW_CAP = 200;

  function reportBody(items) {
    const lines = [
      "xgomi への追加リクエストです。",
      "",
      "| username | 投稿 |",
      "| --- | --- |",
    ];
    for (const r of items)
      lines.push("| @" + r.name + " | " + (r.url || "-") + " |");
    return lines.join("\n");
  }

  function issueUrl(items) {
    const title = "追加リクエスト: " + items.length + " 件";
    return (
      ISSUE_BASE +
      "?title=" +
      encodeURIComponent(title) +
      "&body=" +
      encodeURIComponent(reportBody(items))
    );
  }

  function listRows(b, arr, label, onDelete) {
    const shown = arr.slice(0, ROW_CAP);
    shown.forEach((raw, i) => {
      const e = parseLine(raw) || { type: "?", v: raw };
      b.appendChild(
        h(
          "div",
          { cls: "it" },
          h(
            "div",
            { cls: "gr" },
            h(
              "div",
              { cls: "a mono" },
              e.type === "id"
                ? nameOf(e.v)
                  ? "@" + nameOf(e.v)
                  : e.v
                : "@" + e.v,
            ),
            h("div", { cls: "b mono" }, e.type === "id" ? "id: " + e.v : label),
          ),
          h("button", { cls: "btn d sm", onclick: () => onDelete(i) }, "削除"),
        ),
      );
    });
    if (arr.length > shown.length)
      b.appendChild(
        h("div", { cls: "em" }, `他 ${arr.length - shown.length} 件は非表示`),
      );
  }

  function tabList(b) {
    const ta = h("textarea", {
      cls: "tf",
      placeholder:
        "@username / username / 1234567890 / id:123 / username:foo / URL\n1行1件",
    });
    b.appendChild(
      h(
        "div",
        { cls: "sec" },
        h("div", { cls: "bar" }, ta),
        h(
          "div",
          { cls: "bar" },
          h(
            "button",
            {
              cls: "btn a",
              onclick: () => {
                const add = parseText(ta.value);
                if (!add.length) return toast("追加できる行がありません");
                let n = 0;
                for (const e of add) {
                  const v = (e.type === "id" ? "id:" : "username:") + e.v;
                  if (!local.includes(v)) {
                    local.push(v);
                    n++;
                  }
                }
                saveLocal();
                ta.value = "";
                rebuild();
                renderTab();
                toast(n + " 件追加しました");
              },
            },
            "追加",
          ),
          h(
            "div",
            { cls: "mu", style: "font-size:13px" },
            `手動 ${local.length} 件 / 全体 ${blockIds.size + blockNames.size} 件`,
          ),
        ),
      ),
    );

    b.appendChild(
      h(
        "div",
        { cls: "sec" },
        h("div", { cls: "sh" }, `報告リスト (${report.length})`),
        h(
          "div",
          { cls: "row" },
          h(
            "div",
            { cls: "gr" },
            h(
              "div",
              { cls: "d" },
              "投稿の追加ボタンで入れたアカウントを、xgomiにissueとしてまとめて提出します",
            ),
          ),
        ),
        h(
          "div",
          { cls: "bar" },
          h(
            "button",
            {
              cls: "btn a",
              disabled: !report.length,
              onclick: () => {
                const url = issueUrl(report);
                if (url.length > 7500)
                  toast("件数が多いのでコピーして貼り付けてください");
                W.open(url, "_blank", "noopener");
              },
            },
            "issueを作成",
          ),
          h(
            "button",
            {
              cls: "btn o",
              disabled: !report.length,
              onclick: () => {
                navigator.clipboard.writeText(reportBody(report)).then(
                  () => toast("コピーしました"),
                  () => toast("コピーできませんでした"),
                );
              },
            },
            "本文をコピー",
          ),
          h(
            "button",
            {
              cls: "btn o",
              disabled: !report.length,
              onclick: () => {
                report = [];
                saveReport();
                renderTab();
              },
            },
            "報告リストを空に",
          ),
        ),
      ),
    );
    report.slice(0, ROW_CAP).forEach((r, i) => {
      b.appendChild(
        h(
          "div",
          { cls: "it" },
          h(
            "div",
            { cls: "gr" },
            h("div", { cls: "a mono" }, "@" + r.name),
            h("div", { cls: "b mono" }, r.url || "投稿URLなし"),
          ),
          h(
            "button",
            {
              cls: "btn o sm",
              onclick: () => {
                report.splice(i, 1);
                saveReport();
                renderTab();
              },
            },
            "外す",
          ),
        ),
      );
    });

    const ex = h("textarea", {
      cls: "tf",
      placeholder: "例外にする @username / id（1行1件）",
    });
    b.appendChild(
      h(
        "div",
        { cls: "sec" },
        h("div", { cls: "sh" }, `例外リスト (${except.length})`),
        h(
          "div",
          { cls: "row" },
          h(
            "div",
            { cls: "gr" },
            h(
              "div",
              { cls: "d" },
              "リストに入っていても、ここにあるアカウントは消しません",
            ),
          ),
        ),
        h("div", { cls: "bar" }, ex),
        h(
          "div",
          { cls: "bar" },
          h(
            "button",
            {
              cls: "btn a",
              onclick: () => {
                const add = parseText(ex.value);
                if (!add.length) return toast("追加できる行がありません");
                let n = 0;
                for (const e of add) {
                  const v = (e.type === "id" ? "id:" : "username:") + e.v;
                  if (!except.includes(v)) {
                    except.push(v);
                    n++;
                  }
                }
                saveExcept();
                ex.value = "";
                rebuild();
                renderTab();
                toast(n + " 件を例外にしました（表示に戻すには再読み込み）");
              },
            },
            "例外に追加",
          ),
        ),
      ),
    );
    listRows(b, except, "例外", (i) => {
      except.splice(i, 1);
      saveExcept();
      rebuild();
      renderTab();
    });

    if (!local.length) {
      b.appendChild(h("div", { cls: "em" }, "手動追加はまだありません"));
      return;
    }
    b.appendChild(h("div", { cls: "sh" }, `手動リスト (${local.length})`));
    listRows(b, local, "username", (i) => {
      local.splice(i, 1);
      saveLocal();
      rebuild();
      renderTab();
    });
  }

  function tabSources(b) {
    const inp = h("input", {
      cls: "tf",
      type: "text",
      placeholder: "https://example.com/list.txt",
    });
    b.appendChild(
      h(
        "div",
        { cls: "sec" },
        h("div", { cls: "bar" }, inp),
        h(
          "div",
          { cls: "bar" },
          h(
            "button",
            {
              cls: "btn a",
              onclick: async (e) => {
                const url = inp.value.trim();
                if (!/^https?:\/\//.test(url))
                  return toast("URLを入力してください");
                if (sources.some((s) => s.url === url))
                  return toast("登録済みです");
                const src = { url, enabled: true };
                sources.push(src);
                saveSources();
                let got = false;
                await busy(e.currentTarget, "取得中", async () => {
                  try {
                    const n = await refreshSource(src);
                    got = true;
                    toast(
                      n +
                        " 件読み込みました" +
                        (src.pairs ? "（対応表 " + src.pairs + " 件）" : ""),
                    );
                  } catch (err) {
                    src.error = String(err.message || err);
                    toast("取得に失敗しました");
                  }
                });
                inp.value = "";
                rebuild();
                renderTab();
                if (got) askResolve(src, renderTab);
              },
            },
            "追加",
          ),
          h(
            "div",
            { cls: "mu", style: "font-size:13px" },
            "数字=id / 英数字=username として自動判別",
          ),
        ),
      ),
    );

    sources.forEach((s, i) => {
      const c = cache[s.url] || {};
      const sw = h("div", { cls: "sw" + (s.enabled ? " on" : "") }, h("i"));
      b.appendChild(
        h(
          "div",
          { cls: "it" },
          h(
            "div",
            {
              cls: "gr",
              style: "cursor:pointer",
              onclick: () => {
                s.enabled = !s.enabled;
                saveSources();
                sw.className = "sw" + (s.enabled ? " on" : "");
                renderLock++;
                try {
                  rebuild();
                } finally {
                  renderLock--;
                }
              },
            },
            h(
              "div",
              { cls: "a" },
              s.builtin ? "デフォルトリスト" : s.url.split("/").pop() || s.url,
            ),
            h("div", { cls: "b mono" }, s.url),
            h(
              "div",
              { cls: "b" },
              (c.count == null ? "-" : c.count + " 件") +
                " / " +
                fmtTime(c.at) +
                (s.error ? " / " + s.error : ""),
            ),
            h(
              "div",
              { cls: "b" },
              c.text
                ? s.bare
                  ? "対応表なし " +
                    s.bare +
                    " 件 / 逆引き " +
                    (s.resolve ? "ON" : "OFF")
                  : "対応表つき（逆引き不要）"
                : "",
            ),
          ),
          sw,
          s.bare
            ? h(
                "button",
                {
                  cls: "btn o sm",
                  onclick: () => {
                    s.resolve = !s.resolve;
                    saveSources();
                    rebuild();
                    renderTab();
                    if (s.resolve)
                      resolveIds(50).then((n) => {
                        if (n) toast(n + " 件解決しました");
                        if (dash) renderTab();
                      });
                  },
                },
                s.resolve ? "逆引き停止" : "逆引き",
              )
            : null,
          h(
            "button",
            {
              cls: "btn o sm",
              onclick: async (e) => {
                await busy(e.currentTarget, "取得中", async () => {
                  try {
                    const n = await refreshSource(s);
                    s.error = null;
                    toast(n + " 件読み込みました");
                  } catch (err) {
                    s.error = String(err.message || err);
                    toast("取得に失敗しました");
                  }
                });
                saveSources();
                rebuild();
                renderTab();
                askResolve(s, renderTab);
              },
            },
            "更新",
          ),
          s.builtin
            ? h(
                "button",
                {
                  cls: "btn d sm",
                  disabled: true,
                  title:
                    "デフォルトリストは削除できません（スイッチでOFFにできます）",
                },
                "除去",
              )
            : h(
                "button",
                {
                  cls: "btn d sm",
                  onclick: () => {
                    delete cache[s.url];
                    saveCache();
                    sources.splice(i, 1);
                    saveSources();
                    rebuild();
                    renderTab();
                  },
                },
                "除去",
              ),
        ),
      );
    });
  }

  function tabIds(b) {
    const un = unresolvedIds();
    b.appendChild(
      h(
        "div",
        { cls: "sec" },
        h(
          "div",
          { cls: "bar" },
          h(
            "button",
            {
              cls: "btn a",
              onclick: async (e) => {
                const n = await busy(e.currentTarget, "解決中", (p) =>
                  resolveIds(50, p, true),
                );
                renderTab();
                toast(
                  n
                    ? n + " 件解決しました"
                    : "解決できる id はありませんでした",
                );
              },
            },
            "未解決を逆引き",
          ),
          h(
            "button",
            {
              cls: "btn o",
              onclick: () => {
                idMap = {};
                saveMap();
                rebuild();
                renderTab();
              },
            },
            "対応表を消去",
          ),
          h(
            "div",
            { cls: "mu", style: "font-size:13px" },
            `未解決 ${un.length} 件 / ソース配布 ${Object.keys(feedMap).length} 件`,
          ),
        ),
      ),
    );

    const keys = [...blockIds].filter((k) => nameOf(k)).slice(0, ROW_CAP);
    const others = Object.keys(idMap)
      .filter((k) => idMap[k] && !blockIds.has(k))
      .slice(0, ROW_CAP);
    if (!keys.length && !un.length)
      b.appendChild(h("div", { cls: "em" }, "idのブロック対象はありません"));
    for (const k of keys) {
      b.appendChild(
        h(
          "div",
          { cls: "it" },
          h(
            "div",
            { cls: "gr" },
            h("div", { cls: "a" }, "@" + nameOf(k)),
            h("div", { cls: "b mono" }, k),
          ),
          h(
            "div",
            { cls: "mu", style: "font-size:13px" },
            idMap[k] ? "逆引き" : "ソース配布",
          ),
        ),
      );
    }
    for (const k of un.slice(0, ROW_CAP)) {
      b.appendChild(
        h(
          "div",
          { cls: "it" },
          h(
            "div",
            { cls: "gr" },
            h("div", { cls: "a mono" }, k),
            h("div", { cls: "b" }, "username 未解決（idでの除去は動作します）"),
          ),
        ),
      );
    }
    if (others.length) {
      b.appendChild(
        h(
          "div",
          { cls: "row" },
          h(
            "div",
            { cls: "gr" },
            h("div", { cls: "d" }, `収集済みの対応表: 他 ${others.length} 件`),
          ),
        ),
      );
    }
  }

  function tabSettings(b) {
    b.appendChild(
      h(
        "div",
        { cls: "sec" },
        switchRow("enabled", "有効", "すべての除去処理のオン/オフ", () =>
          renderTab(),
        ),
        switchRow(
          "pruneNetwork",
          "API段階で除去",
          "描画される前にレスポンスから削除する（推奨）",
          null,
          true,
        ),
        switchRow(
          "blockMentions",
          "メンションも対象",
          "対象を@で言及しただけの他人の投稿も消す",
          null,
          true,
        ),
        switchRow(
          "blockProfile",
          "プロフィールを非表示",
          "対象のプロフィールページに案内を出す",
          null,
          true,
        ),
        switchRow(
          "autoResolve",
          "idを自動で逆引き",
          "逆引きを許可したソースの id だけ x.com に問い合わせる",
          null,
          true,
        ),
        switchRow(
          "showButton",
          "ボタンを表示",
          "画面左下のxgomiボタン",
          toggleFab,
        ),
        switchRow(
          "addButton",
          "投稿のメニューに追加",
          "投稿の「…」メニューからリストに追加する",
          () => scheduleScan(),
          true,
        ),
      ),
    );

    const pick = (v, t) => {
      if (!settings.enabled) {
        toast("「有効」がオフのため変更できません", "有効にする", () => {
          settings.enabled = true;
          saveSettings();
          renderTab();
          updateToggleBtn();
          renderLock++;
          try {
            rebuild();
            scheduleScan();
          } finally {
            renderLock--;
          }
        });
        return;
      }
      settings.removeMode = v;
      saveSettings();
      renderTab();
      announce(t);
    };

    b.appendChild(
      h(
        "div",
        { cls: "sec" },
        h("div", { cls: "sh" }, "削除方法"),
        ...[
          ["remove", "DOMから削除", "完全に取り除く"],
          ["hide", "非表示にする", "display:none で隠す"],
        ].map(([v, t, d]) =>
          h(
            "div",
            {
              cls:
                "rd" +
                (settings.removeMode === v ? " on" : "") +
                (settings.enabled ? "" : " of"),
              role: "radio",
              tabindex: "0",
              "aria-checked": settings.removeMode === v ? "true" : "false",
              "aria-disabled": settings.enabled ? null : "true",
              onclick: () => pick(v, t),
              onkeydown: (e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                pick(v, t);
              },
            },
            h("div", { cls: "c" }),
            h(
              "div",
              { cls: "gr" },
              h("div", { cls: "t" }, t),
              h("div", { cls: "d" }, d),
            ),
          ),
        ),
      ),
    );

    const nInp = h("input", {
      cls: "tf",
      type: "number",
      min: "0",
      max: "168",
      value: String(settings.autoUpdateHours),
      style: "width:90px",
      onchange: (e) => {
        settings.autoUpdateHours = Math.max(0, Number(e.target.value) || 0);
        saveSettings();
      },
    });
    const lInp = h("input", {
      cls: "tf",
      type: "number",
      min: "10",
      max: "2000",
      value: String(settings.logLimit),
      style: "width:90px",
      onchange: (e) => {
        settings.logLimit = Math.min(
          2000,
          Math.max(10, Number(e.target.value) || 200),
        );
        e.target.value = String(settings.logLimit);
        saveSettings();
        if (logs.length > settings.logLimit) {
          logs.length = settings.logLimit;
          set(K.log, logs);
        }
      },
    });
    b.appendChild(
      h(
        "div",
        { cls: "sec" },
        h("div", { cls: "sh" }, "自動更新"),
        h(
          "div",
          { cls: "row" },
          h(
            "div",
            { cls: "gr" },
            h("div", { cls: "t" }, "更新間隔（時間）"),
            h("div", { cls: "d" }, "0で自動更新しない"),
          ),
          nInp,
        ),
        h(
          "div",
          { cls: "row" },
          h(
            "div",
            { cls: "gr" },
            h("div", { cls: "t" }, "ログ保持件数"),
            h("div", { cls: "d" }, "古いものから自動で破棄されます"),
          ),
          lInp,
        ),
      ),
    );

    b.appendChild(
      h(
        "div",
        { cls: "sec" },
        h("div", { cls: "sh" }, "データ"),
        h(
          "div",
          { cls: "bar" },
          h(
            "button",
            {
              cls: "btn o",
              onclick: () => {
                const data = JSON.stringify(
                  { sources, local, settings, map: idMap },
                  null,
                  2,
                );
                navigator.clipboard.writeText(data).then(
                  () => toast("コピーしました"),
                  () => toast("コピーできませんでした"),
                );
              },
            },
            "エクスポート",
          ),
          h(
            "button",
            {
              cls: "btn o",
              onclick: () => {
                const s = prompt("エクスポートしたJSONを貼り付け");
                if (!s) return;
                try {
                  const d = JSON.parse(s);
                  if (d.sources) {
                    sources = d.sources;
                    saveSources();
                  }
                  if (d.local) {
                    local = d.local;
                    saveLocal();
                  }
                  if (d.settings) {
                    settings = Object.assign({}, DEFAULT_SETTINGS, d.settings);
                    saveSettings();
                  }
                  if (d.map) {
                    idMap = d.map;
                    saveMap();
                  }
                  rebuild();
                  renderTab();
                  toast("読み込みました");
                } catch (e) {
                  toast("JSONが不正です");
                }
              },
            },
            "インポート",
          ),
          h(
            "button",
            {
              cls: "btn d",
              onclick: () => {
                stats = { tweets: 0, users: 0, api: 0 };
                set(K.stats, stats);
                logs = [];
                set(K.log, logs);
                renderTab();
                toast("リセットしました");
              },
            },
            "統計をリセット",
          ),
        ),
      ),
    );
  }

  function tabLog(b) {
    b.appendChild(
      h(
        "div",
        { cls: "sec" },
        h(
          "div",
          { cls: "bar" },
          h(
            "button",
            {
              cls: "btn o",
              onclick: () => {
                logs = [];
                set(K.log, logs);
                renderTab();
              },
            },
            "クリア",
          ),
          h(
            "div",
            { cls: "mu", style: "font-size:13px" },
            `直近 ${logs.length} 件 / 最大 ${settings.logLimit} 件まで保持`,
          ),
        ),
      ),
    );
    if (!logs.length) {
      b.appendChild(h("div", { cls: "em" }, "まだ何も削除していません"));
      return;
    }
    const kindLabel = { api: "API", tweet: "投稿", user: "ユーザー" };
    for (const l of logs) {
      b.appendChild(
        h(
          "div",
          { cls: "it" },
          h(
            "div",
            { cls: "gr" },
            h("div", { cls: "a mono" }, l.who),
            h(
              "div",
              { cls: "b" },
              (kindLabel[l.kind] || l.kind) + " / " + l.where,
            ),
          ),
          h(
            "div",
            { cls: "mu", style: "font-size:13px" },
            new Date(l.t).toLocaleTimeString(),
          ),
        ),
      );
    }
  }

  let toastEl = null;
  let confirmUI = null;
  function confirmDialog(opt, onOk, onCancel) {
    const p = palette();
    if (!confirmUI) {
      const host = h("div");
      host.style.cssText = "all:initial";
      const sr = host.attachShadow({ mode: "open" });
      const st = h("style");
      st.textContent = `:host{all:initial}
*{box-sizing:border-box;margin:0;padding:0;font-family:var(--f)}
.cv{position:fixed;inset:0;background:rgba(91,112,131,.4);z-index:2147483647;display:flex;align-items:center;justify-content:center;animation:cfade .1s ease}
.cc{width:min(320px,92vw);background:var(--bg);color:var(--tx);border-radius:16px;padding:32px;box-shadow:var(--sh);animation:cpop .12s cubic-bezier(.2,.8,.2,1)}
.ch{font-size:20px;font-weight:800;line-height:24px;margin-bottom:8px}
.cp{font-size:15px;line-height:20px;color:var(--mu);margin-bottom:24px}
.cb{display:block;width:100%;height:44px;border-radius:9999px;font-size:15px;font-weight:700;cursor:pointer;border:1px solid transparent;transition:background .2s ease,filter .2s ease}
.cb:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
.cb.ok{background:var(--ac);color:#fff;margin-bottom:12px}
.cb.ok:hover{filter:brightness(.88)}
.cb.ok.dg{background:#f4212e}
.cb.no{background:transparent;color:var(--tx);border-color:var(--bo)}
.cb.no:hover{background:var(--hv)}
@keyframes cfade{from{opacity:0}to{opacity:1}}
@keyframes cpop{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.cv,.cc{animation:none}.cb{transition:none}}`;
      sr.appendChild(st);
      (document.body || document.documentElement).appendChild(host);
      confirmUI = { host, sr };
    }
    const prev = document.activeElement;
    const close = (confirmed) => {
      if (confirmUI.ov) confirmUI.ov.remove();
      confirmUI.ov = null;
      document.removeEventListener("keydown", onKey, true);
      if (prev && prev.focus) prev.focus({ preventScroll: true });
      if (!confirmed && onCancel) onCancel();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "Tab") {
        e.preventDefault();
        const btns = [ok, no];
        btns[btns.indexOf(confirmUI.sr.activeElement) === 0 ? 1 : 0].focus();
      }
    };
    const ok = h(
      "button",
      {
        cls: "cb ok" + (opt.danger ? " dg" : ""),
        onclick: () => {
          close(true);
          onOk();
        },
      },
      opt.ok,
    );
    const no = h(
      "button",
      { cls: "cb no", onclick: () => close() },
      opt.no || "キャンセル",
    );
    const ov = h(
      "div",
      {
        cls: "cv",
        onclick: (e) => {
          if (e.target === ov) close();
        },
        role: "presentation",
      },
      h(
        "div",
        {
          cls: "cc",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": opt.title,
        },
        h("div", { cls: "ch" }, opt.title),
        h("div", { cls: "cp" }, opt.desc),
        ok,
        no,
      ),
    );
    ov.setAttribute("style", vars(p));
    if (confirmUI.ov) confirmUI.ov.remove();
    confirmUI.ov = ov;
    confirmUI.sr.appendChild(ov);
    document.addEventListener("keydown", onKey, true);
    ok.focus({ preventScroll: true });
  }

  function toast(msg, actionLabel, onAction) {
    const p = palette();
    if (!toastEl) {
      const host = h("div");
      const sr = host.attachShadow({ mode: "open" });
      const st = h("style");
      st.textContent = `.t{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--ac);color:#fff;font-family:var(--f);font-size:14px;font-weight:500;padding:12px 16px;border-radius:4px;z-index:2147483647;max-width:90vw;display:flex;align-items:center;gap:16px;animation:tin .16s ease}
.t button{background:transparent;border:0;color:#fff;font:inherit;font-weight:700;text-decoration:underline;cursor:pointer;padding:0}
@keyframes tin{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}
@media (prefers-reduced-motion:reduce){.t{animation:none}}`;
      sr.appendChild(st);
      const el = h("div", { cls: "t", role: "status", "aria-live": "polite" });
      sr.appendChild(el);
      (document.body || document.documentElement).appendChild(host);
      toastEl = { host, el };
    }
    toastEl.el.setAttribute("style", vars(p));
    toastEl.el.textContent = msg;
    if (actionLabel && onAction)
      toastEl.el.appendChild(
        h(
          "button",
          {
            onclick: () => {
              toastEl.host.style.display = "none";
              onAction();
            },
          },
          actionLabel,
        ),
      );
    toastEl.host.style.display = "";
    toastEl.el.classList.remove("t");
    void toastEl.el.offsetWidth;
    toastEl.el.classList.add("t");
    clearTimeout(toastEl.tm);
    toastEl.tm = setTimeout(
      () => {
        toastEl.host.style.display = "none";
      },
      actionLabel ? 6000 : 2600,
    );
  }

  let noticeFor = "";
  function blockProfilePage() {
    const primary = document.querySelector(
      'main [data-testid="primaryColumn"]',
    );
    const m = /^\/([A-Za-z0-9_]{1,15})(?:\/.*)?$/.exec(location.pathname);
    const mid = /^\/i\/user\/(\d+)/.exec(location.pathname);
    let who = null,
      key = "";
    if (settings.enabled && settings.blockProfile) {
      if (
        m &&
        !RESERVED.has(m[1].toLowerCase()) &&
        blockNames.has(m[1].toLowerCase())
      ) {
        who = "@" + m[1];
        key = m[1].toLowerCase();
      } else if (mid && blockIds.has(mid[1])) {
        who = mid[1];
        key = mid[1];
      }
    }
    if (!who) {
      if (noticeFor) {
        noticeFor = "";
        const old = document.getElementById("xgomi-notice");
        if (old) old.remove();
        document.querySelectorAll("[data-xgomi-hidden]").forEach((el) => {
          el.style.removeProperty("display");
          el.removeAttribute("data-xgomi-hidden");
        });
      }
      return;
    }
    if (!primary) return;
    for (const el of primary.children) {
      if (el.id === "xgomi-notice") continue;
      if (!el.hasAttribute("data-xgomi-hidden")) {
        el.setAttribute("data-xgomi-hidden", "1");
        el.style.setProperty("display", "none", "important");
      }
    }
    if (noticeFor === key && document.getElementById("xgomi-notice")) return;
    noticeFor = key;
    const old = document.getElementById("xgomi-notice");
    if (old) old.remove();
    const p = palette();
    const box = h("div", { id: "xgomi-notice" });
    const sr = box.attachShadow({ mode: "open" });
    const st = h("style");
    st.textContent =
      CSS +
      `
.wrap{padding:48px 32px;max-width:460px;margin:0 auto;text-align:center;font-family:var(--f);color:var(--tx)}
.wrap h2{font-size:20px;font-weight:800;line-height:1.3}
.wrap p{margin-top:8px;font-size:15px;color:var(--mu);line-height:1.5;word-break:break-all}
.wrap .btns{margin-top:24px;display:flex;gap:8px;justify-content:center}
`;
    sr.appendChild(st);
    sr.appendChild(
      h(
        "div",
        { cls: "wrap", style: vars(p) },
        h("h2", null, "このアカウントは非表示です"),
        h(
          "p",
          null,
          who +
            " はブロックリストに含まれているため、投稿とプロフィールを表示していません。",
        ),
        h(
          "div",
          { cls: "btns" },
          h(
            "button",
            {
              cls: "btn o",
              onclick: () => {
                bypass.add(key);
                rebuild();
              },
            },
            "表示する",
          ),
          h("button", { cls: "btn p", onclick: openDash }, "xgomi"),
        ),
      ),
    );
    primary.appendChild(box);
  }

  let fab = null;
  function updateFab() {
    if (!fab) return;
    fab.el.className = "fab" + (settings.enabled ? "" : " off");
    fab.el.textContent = settings.enabled ? "xgomi" : "xgomi ・ 停止中";
    fab.el.setAttribute(
      "aria-label",
      "xgomi ダッシュボードを開く" + (settings.enabled ? "" : "（停止中）"),
    );
  }

  function toggleFab() {
    if (!settings.showButton) {
      if (fab) fab.host.style.display = "none";
      return;
    }
    if (fab) {
      fab.host.style.display = "";
      updateFab();
      applyTheme();
      return;
    }
    const host = h("div");
    const sr = host.attachShadow({ mode: "open" });
    const st = h("style");
    st.textContent = CSS;
    sr.appendChild(st);
    const el = h("button", { cls: "fab", onclick: openDash }, "xgomi");
    sr.appendChild(el);
    (document.body || document.documentElement).appendChild(host);
    fab = { host, el };
    updateFab();
    applyTheme();
  }

  try {
    GM_registerMenuCommand("xgomi ダッシュボード", openDash);
  } catch (e) {}

  function ready(fn) {
    if (document.body) fn();
    else
      new MutationObserver((_r, o) => {
        if (document.body) {
          o.disconnect();
          fn();
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
  }

  rebuild();

  ready(() => {
    toggleFab();
    watchCaret();
    startObserver();
    scheduleScan();
    let last = location.href;
    setInterval(() => {
      if (location.href !== last) {
        last = location.href;
        noticeFor = "";
        if (bypass.size) {
          bypass.clear();
          rebuild();
        }
        scheduleScan();
      }
    }, 400);
    refreshAll(false);
    if (settings.autoResolve) setTimeout(() => resolveIds(20), 5000);
  });
})();
