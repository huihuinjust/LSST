# 历史记忆室

面向南京师范大学 841 中国历史科目的名词主动记忆训练网站。数据来自项目根目录生成的 947 条名词数据库，网站只读取 `public/data/history_terms_database.json`。

## 训练流程

1. 一句话理解与可展开思维导图
2. 答题骨架与记忆串联
3. 遮住答案进行主动回忆
4. 按 10 分制采分点自评
5. 根据得分安排下一次复习

学习进度仅保存在当前浏览器的本地存储中，不需要账号或后端数据库。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm run dev
```

访问 `http://localhost:3000`。

## 验证与构建

```bash
npm run lint
npm run build
```

项目使用 vinext 构建，可部署到 Cloudflare 边缘环境。界面采用移动优先布局，并针对 iPhone 16 的 393 × 852 CSS 视口完成交互验证。
