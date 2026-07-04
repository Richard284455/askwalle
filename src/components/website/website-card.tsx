"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowUpRight,
  BarChart3,
  Check,
  Circle,
  Heart,
  Loader2,
  X,
} from "lucide-react";
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
import type { Website, Category } from "@/lib/types";
import { WebsiteThumbnail } from "./website-thumbnail";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/ui/common/tooltip";

interface WebsiteCardProps {
  website: Website;
  category?: Category;
  isAdmin: boolean;
  onVisit: (website: Website) => void;
  onStatusUpdate: (id: number, status: Website["status"]) => void;
  onLike?: (id: number, newLikes: number) => void;
}

export function WebsiteCard({
  website,
  category,
  isAdmin,
  onVisit,
  onStatusUpdate,
  onLike,
}: WebsiteCardProps) {
  const [likes, setLikes] = useState(website.likes);
  const [isLiking, setIsLiking] = useState(false);
  const prevLikesRef = useRef(website.likes);
  const { cardRef, tiltProps } = useCardTilt({
    maxTiltDegree: 5,
    scale: 1.01,
    transitionZ: 6,
  });

  useEffect(() => {
    if (website.likes !== prevLikesRef.current) {
      setLikes(website.likes);
      prevLikesRef.current = website.likes;
    }
  }, [website.likes]);

  const statusColors: Record<Website["status"], string> = {
    pending: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
    approved: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
    rejected: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    all: "",
  };

  const statusText: Record<Website["status"], string> = {
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
    all: "",
  };

  const handleLike = async () => {
    const key = `website-${website.id}-liked`;
    const lastLiked = localStorage.getItem(key);
    const now = new Date().getTime();
    const oneDay = 24 * 60 * 60 * 1000;

    if (isLiking) return;

    if (lastLiked && now - parseInt(lastLiked) < oneDay) {
      toast({
        title: "已点赞",
        description: "每天只能点赞一次哦，明天再来吧 (｡•́︿•̀｡)",
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
    <div
      ref={cardRef}
      onMouseMove={tiltProps.onMouseMove}
      onMouseEnter={tiltProps.onMouseEnter}
      onMouseLeave={tiltProps.onMouseLeave}
      className="card-container relative [perspective:1000px]"
    >
      <motion.div
        variants={cardHoverVariants}
        initial="initial"
        whileHover="hover"
        whileTap="tap"
        layoutId={`website-${website.id}`}
        transition={sharedLayoutTransition}
        className="h-full"
        style={{ willChange: "transform" }}
      >
        <Card
          className={cn(
            "group flex h-full min-h-[178px] flex-col overflow-hidden rounded-lg border-border/70 bg-card p-3 shadow-sm",
            "transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
          )}
        >
          <div className="flex items-start gap-3">
            <WebsiteThumbnail
              url={website.url}
              thumbnail={website.thumbnail}
              thumbnail_base64={website.thumbnail_base64}
              title={website.title}
              className="h-11 w-11 shrink-0 rounded-md"
            />

            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <h3 className="line-clamp-1 text-sm font-semibold leading-5 group-hover:text-primary">
                  {website.title}
                </h3>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="mt-1 inline-flex h-2.5 w-2.5 shrink-0 rounded-full"
                        aria-label={
                          website.active ? "Website reachable" : "Website unreachable"
                        }
                      >
                        <Circle
                          className={cn(
                            "h-2.5 w-2.5",
                            website.active
                              ? "fill-green-500 text-green-500"
                              : "fill-muted-foreground text-muted-foreground"
                          )}
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{website.active ? "Website reachable" : "Website unreachable"}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge
                  variant="secondary"
                  className="max-w-full truncate px-2 py-0 text-[11px] font-medium"
                >
                  {category?.name || "Uncategorized"}
                </Badge>
                {isAdmin && website.status !== "approved" && (
                  <Badge
                    variant="outline"
                    className={cn(
                      "px-2 py-0 text-[11px] font-medium",
                      statusColors[website.status]
                    )}
                  >
                    {statusText[website.status]}
                  </Badge>
                )}
              </div>
            </div>
          </div>

          <p className="mt-3 line-clamp-2 min-h-[40px] text-xs leading-5 text-muted-foreground">
            {website.description}
          </p>

          <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-3">
            <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <BarChart3 className="h-3.5 w-3.5" />
                {website.visits}
              </span>
              <span className="inline-flex items-center gap-1">
                <Heart className="h-3.5 w-3.5" />
                {likes}
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-1">
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
                variant="default"
                size="sm"
                onClick={() => onVisit(website)}
                className="h-8 gap-1 px-2 text-xs sm:gap-1.5 sm:px-2.5"
                aria-label={`Visit ${website.title}`}
              >
                Visit
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Button>

              {isAdmin && website.status !== "approved" && (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => onStatusUpdate(website.id, "approved")}
                  className="h-8 w-8 hover:border-green-500/30 hover:text-green-600"
                  aria-label={`Approve ${website.title}`}
                >
                  <Check className="h-3.5 w-3.5" />
                </Button>
              )}

              {isAdmin && website.status !== "rejected" && (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => onStatusUpdate(website.id, "rejected")}
                  className="h-8 w-8 hover:border-red-500/30 hover:text-red-600"
                  aria-label={`Reject ${website.title}`}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}
