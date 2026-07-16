export interface Website {
  id: number;
  title: string;
  url: string;
  description: string;
  slug?: string | null;
  category_id: number;
  thumbnail: string | null;
  thumbnail_base64: string | null;
  active: number;
  status: string;
  visits: number;
  likes: number;
  created_at?: string;
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
