# Railway 部署指南

## 概述
本指南帮助你将营销管理协同平台部署到 Railway，实现：
- 公网永久链接，所有同事都能访问
- PostgreSQL 云数据库，数据实时共享
- 用户自助注册，无需管理员创建账号

---

## 第一步：注册 GitHub 账号（如果没有）

1. 打开 https://github.com
2. 点击 **Sign up**
3. 填写邮箱、设置密码、用户名
4. 完成邮箱验证

---

## 第二步：创建 GitHub 仓库并上传代码

### 方式一：用 GitHub 网页上传（最简单）

1. 登录 GitHub，点右上角 **+** → **New repository**
2. 仓库名填 `panke-crm`，选 **Public**，点 **Create repository**
3. 点 **uploading an existing file** 链接
4. 把 `railway-deploy` 文件夹里的所有文件拖进去（包括子文件夹 public）
5. 点 **Commit changes**

### 方式二：用 Git 命令行上传

```bash
cd railway-deploy
git init
git add .
git commit -m "营销管理协同平台"
git branch -M main
git remote add origin https://github.com/你的用户名/panke-crm.git
git push -u origin main
```

### 需要上传的文件结构：
```
panke-crm/
├── server.js          # 后端（PostgreSQL版）
├── package.json       # 依赖配置
├── railway.json       # Railway部署配置
├── .gitignore
└── public/
    └── index.html     # 前端页面
```

---

## 第三步：注册 Railway 账号

1. 打开 https://railway.app
2. 点 **Login** → 选 **Login with GitHub**
3. 授权 Railway 访问你的 GitHub 账号
4. 完成注册（可能需要验证邮箱）

---

## 第四步：创建项目并部署

1. 进入 Railway Dashboard，点 **New Project**

2. 选 **Deploy from GitHub repo**

3. 找到并选择你刚创建的 `panke-crm` 仓库

4. Railway 会自动检测到 Node.js 项目并开始构建

5. **添加 PostgreSQL 数据库**：
   - 在项目页面点 **+ New** → **Database** → **PostgreSQL**
   - Railway 自动创建数据库并设置 `DATABASE_URL` 环境变量

6. 等待构建完成（通常 1-2 分钟）

---

## 第五步：配置环境变量

在 Railway 项目的 **Variables** 标签页，确认以下变量：

| 变量名 | 值 | 说明 |
|--------|---|------|
| `DATABASE_URL` | （自动生成） | Railway 自动注入，无需手动设置 |
| `DATABASE_SSL` | `true` | Railway 数据库需要 SSL 连接 |
| `PORT` | （自动生成） | Railway 自动注入 |

> 注意：如果 `DATABASE_URL` 没有自动出现，在 PostgreSQL 服务页面找到 **Connect** 标签，复制 **Postgres Connection URL**，手动添加到后端服务的环境变量中。

---

## 第六步：获取公网链接

1. 在后端服务页面，点 **Settings** 标签
2. 找到 **Networking** 部分
3. 点 **Generate Domain**
4. Railway 会给你一个永久公网链接，类似：
   `https://panke-crm-production.up.railway.app`

---

## 第七步：验证部署

打开你的公网链接，应该能看到：
- ✅ 登录页面（admin / admin123）
- ✅ 注册新账号功能
- ✅ 19 门店数据
- ✅ 转化看板
- ✅ 客户分析
- ✅ 客户录入、跟进

---

## 常见问题

### Q: 部署后页面空白？
A: 检查 Railway 日志（Deployments 标签 → Logs），看是否有报错。常见原因是 `DATABASE_URL` 没有正确配置。

### Q: 登录提示"服务器错误"？
A: 数据库可能还没初始化。server.js 会在首次启动时自动创建表和导入数据，如果失败请检查日志中的数据库连接错误。

### Q: 同事注册的账号看不到数据？
A: 注册时选择的门店如果不存在，会自动创建新门店。该门店下只有注册用户自己录入的客户数据，看不到其他门店数据。需要管理员（admin）账号来查看全部数据。

### Q: 免费额度够用吗？
A: Railway 提供 $5/月的免费试用额度（无需信用卡），对于小型团队日常使用足够。超出后需要绑定信用卡升级为付费计划（最低 $5/月）。

### Q: 数据会丢失吗？
A: PostgreSQL 数据库数据是持久化的，不会因为重新部署而丢失。但建议定期在 Railway 数据库页面导出备份。

---

## 后续维护

- **更新代码**：在 GitHub 修改代码后 push，Railway 自动重新部署
- **查看日志**：Railway Dashboard → 你的服务 → Deployments → Logs
- **数据库管理**：Railway Dashboard → PostgreSQL 服务 → Data 标签可直接查看和编辑数据
- **自定义域名**：在 Settings → Networking → Custom Domain 绑定自己的域名
