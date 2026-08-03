export interface Website {
  id: number;
  title: string;
  url: string;
  description: string;
  slug?: string | null;
  category_id: number;
  thumbnail: string | null;
  /**
   * 内联 base64 缩略图。**可选，而且列表页不该取。**
   *
   * 它是全表里最重的一列（429 行 3.4MB），但没有任何组件真的渲染它 ——
   * WebsiteThumbnail 声明了这个 prop 却从不引用，图片走的是缓存映射表。
   * 声明成必填会逼着每个查询都把它捞出来，那正是后台首页被拖垮的原因。
   */
  thumbnail_base64?: string | null;
  active: number;
  status: string;
  visits: number;
  likes: number;
  /** Prisma 返回的是 Date；早先这里只写了 string，与实际取到的值对不上 */
  created_at?: string | Date;
}

export interface Category {
  id: number;
  name: string;
  slug: string;
}

export interface FormInputs {
  title: string;
  url: string;
  description: string;
  category_id: string;
  thumbnail?: string;
}

// 设置
export interface Setting {
  id: number;
  key: string;
  value: string;
}

export interface FooterLink {
  title: string;
  url: string;
}

// 页脚设置
export interface FooterSettings {
  links: FooterLink[];
  copyright: string;
  icpBeian: string;
  customHtml: string;
}
