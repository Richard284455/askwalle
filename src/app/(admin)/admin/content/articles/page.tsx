import { listArticlesForReview } from "@/lib/content/article-gen/review";
import { ArticleReviewClient } from "@/components/admin/article-review-client";

export const dynamic = "force-dynamic";

export default async function ContentArticleReviewPage() {
  const items = await listArticlesForReview({ limit: 100 }).catch(() => []);
  return <ArticleReviewClient initial={items} />;
}
