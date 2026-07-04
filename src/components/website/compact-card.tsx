"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { motion } from "framer-motion";
import { ArrowUpRight, BarChart3, Heart, Loader2 } from "lucide-react";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";
import { toast } from "@/hooks/use-toast";
import { useCardTilt } from "@/hooks/use-card-tilt";
import { cn } from "@/lib/utils/utils";
import {
  cardHoverVariants,
  sharedLayoutTransition,
} from "@/ui/animation/variants/animations";
import type { Website } from "@/lib/types";
import { WebsiteThumbnail } from "./website-thumbnail";

interface CompactCardProps {
  website: Website;
  onVisit: (website: Website) => void;
  onLike?: (id: number, newLikes: number) => void;
}

export function CompactCard({ website, onVisit, onLike }: CompactCardProps) {
  const [likes, setLikes] = useState(website.likes);
  const [isLiking, setIsLiking] = useState(false);
  const prevLikesRef = useRef(website.likes);
  const { cardRef, tiltProps } = useCardTilt({
    maxTiltDegree: 4,
    scale: 1.01,
    transitionZ: 4,
  });

  useEffect(() => {
    if (website.likes !== prevLikesRef.current) {
      setLikes(website.likes);
      prevLikesRef.current = website.likes;
    }
  }, [website.likes]);

  const handleVisit = () => {
    onVisit(website);
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleVisit();
    }
  };

  const handleVisitClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    handleVisit();
  };

  const handleLike = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const key = `website-${website.id}-liked`;
    const lastLiked = localStorage.getItem(key);
    const now = new Date().getTime();
    const oneDay = 24 * 60 * 60 * 1000;

    if (isLiking) return;

    if (lastLiked && now - parseInt(lastLiked) < oneDay) {
      toast({
        title: "已点赞",
        description: "你已经点赞了，请过段时间再来吧 (｡•́︿•̀｡)",
      });
      return;
    }

    setIsLiking(true);

    try {
      const response = await fetch(`/api/websites/${website.id}/like`, {
        method: "POST",
      });
      const data = await response.json();
      localStorage.setItem(key, now.toString());

      let newLikes: number;
      if (data.code === 200 && data.data?.likes !== undefined) {
        newLikes = data.data.likes;
      } else {
        newLikes = likes + 1;
      }

      setLikes(newLikes);
      onLike?.(website.id, newLikes);
      toast({
        title: "点赞成功",
        description: "感谢您的支持！",
      });
    } catch (error) {
      console.error("点赞失败:", error);
      toast({
        title: "点赞失败",
        description: "请稍后重试",
        variant: "destructive",
      });
    } finally {
      setIsLiking(false);
    }
  };

  return (
    <div ref={cardRef} {...tiltProps} className="card-container">
      <motion.div
        variants={cardHoverVariants}
        initial="initial"
        whileHover="hover"
        whileTap="tap"
        layoutId={`website-${website.id}`}
        transition={sharedLayoutTransition}
      >
        <Card
          className={cn(
            "group flex min-h-[96px] cursor-pointer items-center gap-3 rounded-lg border-border/70 bg-card p-3 shadow-sm",
            "transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
          )}
          onClick={handleVisit}
          onKeyDown={handleCardKeyDown}
          role="button"
          tabIndex={0}
        >
          <WebsiteThumbnail
            url={website.url}
            thumbnail={website.thumbnail}
            thumbnail_base64={website.thumbnail_base64}
            title={website.title}
            className="h-10 w-10 shrink-0 rounded-md"
          />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold group-hover:text-primary">
                {website.title}
              </h3>
              {website.status !== "approved" && (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                  {website.status}
                </Badge>
              )}
            </div>
            <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
              {website.description}
            </p>
            <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <BarChart3 className="h-3 w-3" />
                {website.visits}
              </span>
              <span className="inline-flex items-center gap-1">
                <Heart className="h-3 w-3" />
                {likes}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="icon"
              onClick={handleLike}
              disabled={isLiking}
              className="h-8 w-8"
              aria-label={`Like ${website.title}`}
            >
              {isLiking ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Heart className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleVisitClick}
              className="h-8 w-8 text-primary"
              aria-label={`Visit ${website.title}`}
            >
              <ArrowUpRight className="h-4 w-4" />
            </Button>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}
