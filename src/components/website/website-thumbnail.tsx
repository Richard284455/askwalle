"use client";

import { useState } from "react";
import { Globe } from "lucide-react";
import { cn } from "@/lib/utils/utils";
import {
  thumbnailCacheMap,
  thumbnailPlaceholder,
} from "@/lib/website/thumbnail-cache-map";

interface WebsiteThumbnailProps {
  url: string;
  thumbnail: string | null;
  /**
   * @deprecated 这个组件**从不使用它** —— 下面解构完就再没引用过，
   * 图片实际走的是 thumbnailCacheMap。留着只是为了不改动一堆调用点。
   *
   * **不要为了它去查库。** thumbnail_base64 是 website 表最重的一列
   * （429 行 3.4MB），后台首页整表取它一次要 112 秒、占满一条连接，
   * 直接把只有 5 条的连接池拖垮 —— 表现出来是「登录后后台打不开」。
   */
  thumbnail_base64?: string | null;
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
