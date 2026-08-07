"use client";

import { useState } from "react";
import { Globe } from "lucide-react";
import { cn } from "@/lib/utils/utils";
import {
  thumbnailCacheMap,
  thumbnailPlaceholder,
} from "@/lib/website/thumbnail-cache-map";

/**
 * 缩略图。
 *
 * **没有 thumbnail_base64 这个 prop。**
 *
 * 曾经有，但组件从来没用过它：解构完就再没引用，图片一直走
 * thumbnailCacheMap。代价却是实打实的 —— website 表里那一列
 * 429 行占 3.4MB（全表的 95%），后台首页整表取一次要 112 秒、
 * 占满一条连接，把只有 5 条的池拖垮，表现出来是「登录后后台打不开」。
 *
 * 所以连同各处查询里的 `thumbnail_base64: true` 一起清掉了。
 * 以后要用内联 base64，请先想清楚谁来渲染它、以及列表页要不要为它买单。
 */
interface WebsiteThumbnailProps {
  url: string;
  thumbnail: string | null;
  title: string;
  className?: string;
}

export function WebsiteThumbnail({
  url,
  thumbnail,
  title,
  className,
}: WebsiteThumbnailProps) {
  const [imageError, setImageError] = useState(false);
  const cachedSrc = resolveCachedThumbnail(url, thumbnail);
  const thumbnailSrc = imageError ? thumbnailPlaceholder : cachedSrc;

  if (!thumbnailSrc || thumbnailSrc === thumbnailPlaceholder) {
    return (
      <div
        className={cn(
          "relative w-10 h-10 rounded-lg bg-primary/5 flex items-center justify-center",
          "group-hover:bg-primary/10 transition-colors duration-300",
          className
        )}
      >
        <Globe className="h-5 w-5 text-primary/50" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative w-10 h-10 rounded-lg overflow-hidden",
        "group-hover:ring-2 ring-primary/20 transition-all duration-300",
        className
      )}
    >
      <img
        src={thumbnailSrc}
        alt={title}
        className="h-full w-full object-cover"
        onError={() => setImageError(true)}
      />
    </div>
  );
}

function resolveCachedThumbnail(url: string, thumbnail: string | null) {
  const keys = [thumbnail, url, faviconUrl(url), iconHorseUrl(url)].filter(
    Boolean
  ) as string[];

  for (const key of keys) {
    const cachedPath = thumbnailCacheMap[key];
    if (cachedPath) return cachedPath;
  }

  return thumbnailPlaceholder;
}

function faviconUrl(value: string) {
  try {
    return new URL("/favicon.ico", value).toString();
  } catch {
    return null;
  }
}

function iconHorseUrl(value: string) {
  try {
    return `https://icon.horse/icon/${new URL(value).hostname}`;
  } catch {
    return null;
  }
}
