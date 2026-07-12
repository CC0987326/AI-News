# 🚀 AI 信息阅览 - 部署指南

本文档指导你将本应用部署到公网，使其可以通过专用网址随时随地访问。

---

## 准备工作

### 1. 获取 DeepSeek API Key（翻译必需）

1. 访问 [DeepSeek 开放平台](https://platform.deepseek.com/)（国内直接访问）
2. 注册账号 → 登录
3. 左侧「API Keys」→「创建 API Key」
4. 复制 Key，填入项目根目录的 `.env` 文件：

```
DEEPSEEK_API_KEY=sk-你的key在这里
```

### 2. 安装依赖（已完成）

```bash
npm install
```

### 3. 验证本地运行

```bash
npm start
```

浏览器打开 http://localhost:3000 ，确认能正常显示。

---

## 方式一：Zeabur 部署 ⭐ 推荐

[Zeabur](https://zeabur.com) 是中国团队开发的部署平台，国内访问极快，支持 Node.js，**有免费额度**。

### 部署步骤

**1. 安装 Git 并提交代码**（如已安装 Git 可跳过）

```bash
# 在项目目录执行
git init
git add .
git commit -m "初始化 AI 信息阅览"
```

**2. 在 Zeabub 创建项目**
- 访问 https://zeabur.com → 用 GitHub 登录
- 点击「新建项目」→ 输入项目名称
- 选择「从 Git 部署」→ 连接你的 GitHub 仓库（需先将代码推送到 GitHub）

> 你也可以点击「命令行部署」直接上传代码，无需 GitHub

**3. 配置环境变量**
- 在 Zeabur 项目页面 →「环境变量」
- 添加：
  - `DEEPSEEK_API_KEY` = `sk-你的key`

**4. 部署**
- Zeabur 会自动检测到 `package.json`，选择 Node.js 构建
- 启动命令自动为 `npm start`
- 部署完成后，你会得到一个 `https://你的项目.zeabur.app` 的网址

**5. 绑定自定义域名（可选）**
- 在 Zeabur 项目设置中绑定你的域名

---

## 方式二：Railway 部署

[Railway](https://railway.app) 国际平台，在中国大陆访问速度中等，提供免费额度。

**步骤：**
1. Fork/推送代码到 GitHub
2. 登录 Railway →「New Project」→「Deploy from GitHub repo」
3. 选择仓库 → 自动部署
4. 设置环境变量：`DEEPSEEK_API_KEY`
5. 获得 `https://你的项目.up.railway.app` 网址

---

## 方式三：阿里云 ECS / 轻量服务器

如果你已有国内云服务器（阿里云、腾讯云等），可直接部署：

### 服务器操作（CentOS/Ubuntu）

```bash
# 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# 克隆代码
git clone <你的仓库地址>
cd AI-News

# 配置 API Key
echo "DEEPSEEK_API_KEY=sk-你的key" > .env

# 安装依赖 & 启动
npm install
npm start
```

### 使用 PM2 实现持久运行（推荐）

```bash
npm install -g pm2
pm2 start server.js --name ai-news
pm2 save
pm2 startup  # 设置开机自启
```

### Nginx 反向代理（域名 + HTTPS）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# 然后用 certbot 配置 HTTPS
```

### 防火墙

```bash
# 开放端口
sudo ufw allow 3000
# 或直接配置云服务商的安全组规则
```

---

## 方式四：Hugging Face Spaces（免费）

[Hugging Face Spaces](https://huggingface.co/spaces) 提供免费 Node.js 托管。

**步骤：**
1. 创建 Space → 选择「Docker」或「Static」
2. 上传代码（或连接 GitHub）
3. 在 Settings → Repository Secrets 设置 `DEEPSEEK_API_KEY`
4. Space 启动后即可访问

---

## 部署后检查清单

- [ ] 访问网址，首页能正常加载
- [ ] 点击「刷新」能触发新闻抓取
- [ ] 点击英文新闻的「🇨🇳 翻译」按钮，能成功翻译为中文
- [ ] 各板块切换正常
- [ ] 手机访问响应式布局正常

---

## 常见问题

### Q: DeepSeek 翻译报错 "未配置 API Key"？
检查 `.env` 文件是否在项目根目录，格式是否正确：
```
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxx
```
**注意：** `=` 后面不要加引号，直接写 key。

### Q: 部署后 RSS 抓取失败？
- 某些 RSS 源可能被云服务商屏蔽
- 可以检查服务器日志定位问题
- 不影响欢迎页和示例数据（可手动加载示例）

### Q: 如何查看服务器日志？
```bash
# 如果使用 PM2
pm2 logs ai-news

# 直接运行
npm start  # 日志直接输出到终端
```

### Q: 如何更新代码？
```bash
# 拉取最新代码
git pull
# 重启服务
pm2 restart ai-news
```
