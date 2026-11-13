import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type FeedVideo = Tables<"videos"> & {
  profiles: { username: string; display_name: string | null; avatar_url: string | null } | null;
};
export type HouseAd = Tables<"ads">;
export type FeedEntry = { kind: "video"; video: FeedVideo } | { kind: "ad"; ad: HouseAd | null; key: string };
export type FeedTab = "foryou" | "fire" | "following" | "trending" | "nearby";

const SELECT = "*, profiles(username, display_name, avatar_url)";

function getCachedFeed(tab: string): FeedVideo[] {
  try {
    const raw = localStorage.getItem(`funtok_feed_${tab}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setCachedFeed(tab: string, videos: FeedVideo[]) {
  try {
    if (videos && videos.length > 0) {
      localStorage.setItem(`funtok_feed_${tab}`, JSON.stringify(videos.slice(0, 40)));
    }
  } catch {}
}

export async function fetchFeed(tab: FeedTab, userId?: string): Promise<FeedVideo[]> {
  if (tab === "fire") return [];

  // Offline fallback: load cached feed immediately
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    const cached = getCachedFeed(tab);
    if (cached.length) return cached;
  }

  try {
    if (tab === "trending") {
      const { data } = await supabase.from("videos").select(SELECT).eq("visibility", "public").order("trending_score", { ascending: false }).limit(50);
      const res = (data ?? []) as FeedVideo[];
      if (res.length) setCachedFeed(tab, res);
      return res.length ? res : getCachedFeed(tab);
    }
    if (tab === "nearby") {
      const { data } = await supabase.from("videos").select(SELECT).eq("visibility", "public").ilike("location", "%kampala%").order("created_at", { ascending: false }).limit(30);
      const res = (data ?? []) as FeedVideo[];
      if (res.length) setCachedFeed(tab, res);
      return res.length ? res : getCachedFeed(tab);
    }
    if (tab === "following") {
      if (!userId) return getCachedFeed(tab);
      const { data: f } = await supabase.from("follows").select("following_id").eq("follower_id", userId);
      const ids = (f ?? []).map((r) => r.following_id);
      if (!ids.length) return getCachedFeed(tab);
      const { data } = await supabase.from("videos").select(SELECT).eq("visibility", "public").in("user_id", ids).order("created_at", { ascending: false }).limit(30);
      const res = (data ?? []) as FeedVideo[];
      if (res.length) setCachedFeed(tab, res);
      return res.length ? res : getCachedFeed(tab);
    }

    // For You: top 20 trending + fresh videos
    const since = new Date(Date.now() - 3600_000).toISOString();
    const [top, fresh] = await Promise.all([
      supabase.from("videos").select(SELECT).eq("visibility", "public").order("trending_score", { ascending: false }).limit(20),
      supabase.from("videos").select(SELECT).eq("visibility", "public").gt("created_at", since).order("created_at", { ascending: false }).limit(5),
    ]);
    const mixed = mixForYou((top.data ?? []) as FeedVideo[], (fresh.data ?? []) as FeedVideo[]);
    if (mixed.length) setCachedFeed(tab, mixed);
    return mixed.length ? mixed : getCachedFeed(tab);
  } catch (err) {
    console.warn("Network offline, loaded cached feed", err);
    return getCachedFeed(tab);
  }
}

export function mixForYou<T extends { id: string }>(top: T[], fresh: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  const freshQ = fresh.filter((f) => !top.some((t) => t.id === f.id));
  let ti = 0;
  while (ti < top.length || freshQ.length) {
    const useFresh = freshQ.length > 0 && ((out.length + 1) % 5 === 0 || ti >= top.length);
    const next = useFresh ? freshQ.shift()! : top[ti++];
    if (next && !seen.has(next.id)) { seen.add(next.id); out.push(next); }
  }
  return out;
}

export function injectAds(videos: FeedVideo[], ads: HouseAd[], every: number, enabled: boolean): FeedEntry[] {
  const out: FeedEntry[] = [];
  videos.forEach((v, i) => {
    out.push({ kind: "video", video: v });
    if (enabled && every > 0 && (i + 1) % every === 0) {
      out.push({ kind: "ad", ad: ads.length ? ads[(i / every) % ads.length | 0] ?? null : null, key: `ad-${i}` });
    }
  });
  return out;
}

export async function fetchAdSetup() {
  try {
    const [cfg, ads] = await Promise.all([
      supabase.from("ad_config").select("*").eq("id", 1).maybeSingle(),
      supabase.from("ads").select("*").eq("is_active", true).limit(20),
    ]);
    return { enabled: cfg.data?.ads_enabled ?? true, every: cfg.data?.feed_ad_frequency ?? 5, ads: ads.data ?? [] };
  } catch {
    return { enabled: false, every: 5, ads: [] };
  }
}

export const trackAd = (id: string, kind: "impression" | "click") => supabase.rpc("track_ad", { _ad_id: id, _kind: kind }).then(() => {});
