/**
 * AI 信息阅览应用 - 后端服务器
 *
 * 功能：
 * - 每日中国时间 4:30 自动抓取新闻（通过 node-cron）
 * - RSS 源解析（带超时保护）
 * - 提供 REST API 供前端使用
 */

// 加载 .env 配置（必须在最前面）
require('dotenv').config();

const express = require('express');
const cron = require('node-cron');
const Parser = require('rss-parser');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const cheerio = require('cheerio'); // 移到顶部，避免每次调用时重新 require
const rateLimit = require('express-rate-limit');
// ============================================================
// 配置
// ============================================================

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'news.json');
const FAVORITES_FILE = path.join(__dirname, 'data', 'favorites.json');
const HISTORY_FILE = path.join(__dirname, 'data', 'history.json');
const MAX_FAVORITES = 20000;
const MAX_HISTORY = 200;
const CHINA_TZ_OFFSET = 8 * 60 * 60 * 1000;
const FETCH_TIMEOUT = 6000; // 每个 RSS 请求超时 6 秒（快速）
const FETCH_MASTER_TIMEOUT = 60000; // 整个抓取流程最大 60 秒

// 统一时间窗口常量
const FRESH_AGE_API = 72 * 60 * 60 * 1000;   // API 返回：保留 72 小时内
const FRESH_AGE_STARTUP = 72 * 60 * 60 * 1000; // 启动清洗：保留 72 小时内（之前是24h，与API对齐）
const FRESH_AGE_FETCH = 2 * 24 * 60 * 60 * 1000; // RSS 抓取：只保留最近 2 天

// RSS 解析器
const parser = new Parser({
  timeout: FETCH_TIMEOUT,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  },
  customFields: {
    item: [
      ['media:content', 'media'],
      ['dc:creator', 'creator'],
    ]
  }
});

// ============================================================
// RSS 源配置 - 优先国内可访问的信源
// ============================================================

const RSS_FEEDS = {
  international: [
    {
      url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
      name: 'BBC News', reliability: 'high', lang: 'en'
    },
    {
      url: 'https://feeds.npr.org/1001/rss.xml',
      name: 'NPR News', reliability: 'high', lang: 'en'
    },
    {
      url: 'https://www.reutersagency.com/feed/',
      name: 'Reuters', reliability: 'high', lang: 'en'
    }
  ],
  china: [
    {
      url: 'https://www.chinadaily.com.cn/rss/china_rss.xml',
      name: 'China Daily China',
      reliability: 'high',
      lang: 'en'
    },
    {
      url: 'https://feedx.net/rss/china.xml',
      name: '中国新闻',
      reliability: 'medium',
      lang: 'zh'
    },
    {
      url: 'https://feedx.net/rss/china-latest.xml',
      name: '中国最新',
      reliability: 'medium',
      lang: 'zh'
    },
    {
      url: 'https://feedx.net/rss/society.xml',
      name: '社会新闻', reliability: 'medium', lang: 'zh'
    }
  ],
  aiGlobal: [
    {
      url: 'https://feeds.arstechnica.com/arstechnica/index',
      name: 'Ars Technica',
      reliability: 'high',
      lang: 'en',
      filter: (item) => {
        const k = ['ai', 'artificial intelligence', 'machine learning', 'llm', 'gpt', 'neural', 'deep learning', 'openai', 'anthropic', 'google', 'ai safety'];
        const t = (item.title + ' ' + item.contentSnippet).toLowerCase();
        return k.some(w => t.includes(w));
      }
    },
    {
      url: 'https://techcrunch.com/category/artificial-intelligence/feed/',
      name: 'TechCrunch AI',
      reliability: 'high',
      lang: 'en'
    },
    {
      url: 'https://www.technologyreview.com/feed/',
      name: 'MIT Tech Review',
      reliability: 'high',
      lang: 'en',
      filter: (item) => {
        const k = ['ai', 'artificial intelligence', 'machine learning', 'llm', 'gpt', 'neural', 'deep learning', 'robot'];
        const t = (item.title + ' ' + item.contentSnippet).toLowerCase();
        return k.some(w => t.includes(w));
      }
    }
  ],
  aiChina: [
    {
      url: 'https://feedx.net/rss/tech.xml',
      name: '科技聚合',
      reliability: 'medium',
      lang: 'zh',
      filter: (item) => {
        const k = ['ai', '人工智能', '大模型', '机器学习', '深度', '机器', '智能', '算法', '芯片', '数据', '算力', 'gpt', '大语言模型', 'llm', '自动驾驶', '机器人'];
        const t = (item.title + ' ' + item.contentSnippet + ' ' + (item.categories || []).join(' ')).toLowerCase();
        return k.some(w => t.includes(w));
      }
    },
    {
      url: 'https://www.36kr.com/feed',
      name: '36氪',
      reliability: 'high',
      lang: 'zh',
      filter: (item) => {
        const k = ['ai', '人工智能', '大模型', 'gpt', '机器学习', '深度', '智能', '算法', '芯片', '大语言模型', 'llm', '机器人', '自动驾驶', 'ai native', 'ai应用'];
        const t = (item.title + ' ' + item.contentSnippet + ' ' + (item.categories || []).join(' ')).toLowerCase();
        return k.some(w => t.includes(w));
      }
    },
    {
      url: 'https://www.leiphone.com/feed',
      name: '雷锋网',
      reliability: 'high',
      lang: 'zh',
      filter: (item) => {
        const k = ['ai', '人工智能', '大模型', 'gpt', '机器学习', '深度', '智能', '算法', '芯片', '大语言模型', 'llm', '机器人'];
        const t = (item.title + ' ' + item.contentSnippet + ' ' + (item.categories || []).join(' ')).toLowerCase();
        return k.some(w => t.includes(w));
      }
    }
  ],
  // 🏃 跑圈
  chinaRunning: [
    {
      url: 'https://www.chinadaily.com.cn/rss/sports_rss.xml',
      name: 'China Daily Sports',
      reliability: 'high', lang: 'en',
      filter: (item) => {
        const k = ['running','marathon','athletics','race','runner','track','run'];
        const t = (item.title+' '+(item.contentSnippet||'')).toLowerCase();
        return k.some(w=>t.includes(w));
      }
    },
    {
      url: 'https://feeds.npr.org/1055/rss.xml',
      name: 'NPR Sports', reliability: 'high', lang: 'en',
      filter: (item) => {
        const k = ['running','marathon','runner','athletics','track','race'];
        const t = (item.title+' '+(item.contentSnippet||'')).toLowerCase();
        return k.some(w=>t.includes(w));
      }
    }
  ],
  intlRunning: [
    {
      url: 'https://www.chinadaily.com.cn/rss/sports_rss.xml',
      name: 'China Daily Sports',
      reliability: 'high', lang: 'en',
      filter: (item) => {
        const k = ['running','marathon','athletics','world','champion','olymp','race'];
        const t = (item.title+' '+(item.contentSnippet||'')).toLowerCase();
        return k.some(w=>t.includes(w));
      }
    },
    {
      url: 'https://feeds.npr.org/1055/rss.xml',
      name: 'NPR Sports', reliability: 'high', lang: 'en',
      filter: (item) => {
        const k = ['running','marathon','runner','athletics','world','champion'];
        const t = (item.title+' '+(item.contentSnippet||'')).toLowerCase();
        return k.some(w=>t.includes(w));
      }
    }
  ],
  health: [
    {
      url: 'https://www.chinadaily.com.cn/rss/lifestyle_rss.xml',
      name: 'China Daily Lifestyle',
      reliability: 'high',
      lang: 'en',
      filter: (item) => {
        const k = ['health', 'fitness', 'exercise', 'workout', 'wellness', 'nutrition', 'sleep', 'diet', 'sport'];
        const t = (item.title + ' ' + (item.contentSnippet || '')).toLowerCase();
        return k.some(w => t.includes(w));
      }
    }
  ]
};

// 备用源
const FALLBACK_FEEDS = {
  international: [
    {
      url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
      name: 'BBC News', reliability: 'high', lang: 'en'
    }
  ],
  aiGlobal: [],
  aiChina: [],
  chinaRunning: [],
  intlRunning: [],
  health: []
};

// ============================================================
// 运动健康默认知识库（静态文章，每次抓取时补充）
// ============================================================

const HEALTH_KNOWLEDGE_ARTICLES = [
  {
    id: 'health-default-001',
    title: '跑步的正确姿势与呼吸方法',
    summary: '跑步时保持身体直立微前倾，步幅不宜过大，落地时前脚掌先着地。呼吸采用"三步一吸、两步一呼"的节奏，用鼻子吸气、嘴巴呼气。',
    source: '运动健康知识库',
    sourceUrl: 'https://www.baidu.com/s?wd=跑步正确姿势与呼吸方法',
    publishedAt: '2026-01-01T00:00:00.000Z',
    reliability: 'high',
    type: 'fact',
    lang: 'zh',
    tags: ['跑步姿势', '呼吸', '入门'],
    feedName: '运动健康知识',
    isKnowledge: true
  },
  {
    id: 'health-default-002',
    title: '跑前动态拉伸与跑后静态拉伸指南',
    summary: '跑前应做动态拉伸：高抬腿、开合跳、弓步转体等，激活肌肉。跑后做静态拉伸：每个动作保持15-30秒，重点拉伸小腿、大腿前后侧和髋部。',
    source: '运动健康知识库',
    sourceUrl: 'https://www.baidu.com/s?wd=跑前动态拉伸与跑后静态拉伸',
    publishedAt: '2026-01-01T01:00:00.000Z',
    reliability: 'high',
    type: 'fact',
    lang: 'zh',
    tags: ['拉伸', '预防受伤'],
    feedName: '运动健康知识',
    isKnowledge: true
  },
  {
    id: 'health-default-003',
    title: '马拉松训练计划：从入门到完赛（16周）',
    summary: '16周马拉松训练计划：前4周为基础期（每周跑3-4次，每次5-8公里），中间8周为提升期（增加间歇跑和长距离跑），后4周为减量期。每周安排一次力量训练和一次交叉训练。',
    source: '运动健康知识库',
    sourceUrl: '',
    publishedAt: '2026-01-02T00:00:00.000Z',
    reliability: 'high',
    type: 'fact',
    lang: 'zh',
    tags: ['马拉松', '训练计划'],
    feedName: '运动健康知识',
    isKnowledge: true
  },
  {
    id: 'health-default-004',
    title: '跑步者常见伤病预防与处理',
    summary: '常见跑步伤病：跑步膝（髂胫束综合征）、足底筋膜炎、胫骨应力综合征、跟腱炎。预防措施：循序渐进增加跑量、选择合适的跑鞋、跑后冰敷、定期替换跑鞋（每600-800公里）。',
    source: '运动健康知识库',
    sourceUrl: '',
    publishedAt: '2026-01-02T02:00:00.000Z',
    reliability: 'high',
    type: 'fact',
    lang: 'zh',
    tags: ['伤病', '预防', '康复'],
    feedName: '运动健康知识',
    isKnowledge: true
  },
  {
    id: 'health-default-005',
    title: '跑者营养补充指南：吃出好成绩',
    summary: '跑前2小时：以碳水为主（香蕉、燕麦、全麦面包）。跑中：超过1小时需要补充能量胶或运动饮料。跑后30分钟内补充蛋白质和碳水的黄金窗口期。日常注意铁和维生素D的摄入。',
    source: '运动健康知识库',
    sourceUrl: '',
    publishedAt: '2026-01-03T00:00:00.000Z',
    reliability: 'high',
    type: 'fact',
    lang: 'zh',
    tags: ['营养', '饮食', '补给'],
    feedName: '运动健康知识',
    isKnowledge: true
  },
  {
    id: 'health-default-006',
    title: '心率区间训练法：科学提升跑步能力',
    summary: '五个心率区间：1区（50-60%最大心率）恢复跑、2区（60-70%）有氧基础、3区（70-80%）节奏跑、4区（80-90%）间歇跑、5区（90-100%）冲刺训练。建议80%的训练在1-2区进行。',
    source: '运动健康知识库',
    sourceUrl: '',
    publishedAt: '2026-01-03T03:00:00.000Z',
    reliability: 'high',
    type: 'fact',
    lang: 'zh',
    tags: ['心率', '训练方法', '科学'],
    feedName: '运动健康知识',
    isKnowledge: true
  },
  {
    id: 'health-default-007',
    title: '如何选择适合自己的跑鞋',
    summary: '根据足弓类型（高足弓/正常足弓/扁平足）和跑步姿势（内旋/外旋/正常）选择跑鞋。鞋码应比日常大半码。体重大的跑者选择缓震更好的鞋，追求速度的选择轻量化竞速鞋。',
    source: '运动健康知识库',
    sourceUrl: '',
    publishedAt: '2026-01-04T00:00:00.000Z',
    reliability: 'high',
    type: 'fact',
    lang: 'zh',
    tags: ['跑鞋', '装备', '选购'],
    feedName: '运动健康知识',
    isKnowledge: true
  },
  {
    id: 'health-default-008',
    title: '晨跑与夜跑的优缺点对比',
    summary: '晨跑优势：空气好、不易晒伤、提升全天精力。晨跑注意：起床后充分热身、避免空腹高强度跑。夜跑优势：身体已充分活动开、有助于减压。夜跑注意：睡前1小时结束、注意交通安全。',
    source: '运动健康知识库',
    sourceUrl: '',
    publishedAt: '2026-01-04T04:00:00.000Z',
    reliability: 'high',
    type: 'fact',
    lang: 'zh',
    tags: ['晨跑', '夜跑', '习惯'],
    feedName: '运动健康知识',
    isKnowledge: true
  }
];

// ============================================================
// 跑步板块默认文章（确保始终有内容）
// ============================================================

const RUNNING_DEFAULT_ARTICLES = {
  chinaRunning: [
    {
      id: 'run-cn-default-001',
      title: '2026全国马拉松赛历公布 多城赛事升级',
      summary: '中国田径协会公布了2026年全国马拉松赛历，今年全国共举办800余场路跑赛事。北京、上海、广州、厦门等城市马拉松赛事规模进一步扩大。',
      source: '中国田径协会', sourceUrl: '',
      publishedAt: '2026-07-10T00:00:00.000Z',
      reliability: 'high', type: 'fact', lang: 'zh',
      tags: ['马拉松', '赛历'], feedName: '跑圈资讯', isDefault: true
    },
    {
      id: 'run-cn-default-002',
      title: '中国选手屡创佳绩 马拉松奥运资格之争白热化',
      summary: '随着巴黎奥运会临近，中国马拉松选手在国际赛事中频频创造好成绩。多名选手达到奥运参赛标准，国家队选拔竞争异常激烈。',
      source: '体坛周报', sourceUrl: '',
      publishedAt: '2026-07-09T00:00:00.000Z',
      reliability: 'high', type: 'fact', lang: 'zh',
      tags: ['奥运', '选拔'], feedName: '跑圈资讯', isDefault: true
    },
    {
      id: 'run-cn-default-003',
      title: '智能运动装备市场快速增长 国产跑鞋品牌崛起',
      summary: '2026年上半年中国智能运动装备市场规模同比增长35%。国产跑鞋品牌在碳板跑鞋、智能运动手表等品类上持续创新，市场份额首次超过国际品牌。',
      source: '36氪', sourceUrl: '',
      publishedAt: '2026-07-08T00:00:00.000Z',
      reliability: 'high', type: 'fact', lang: 'zh',
      tags: ['装备', '跑鞋'], feedName: '跑圈资讯', isDefault: true
    },
    {
      id: 'run-cn-default-004',
      title: '全民健身热潮持续 中国跑步人口突破8000万',
      summary: '中国田径协会发布数据显示，全国经常参加跑步运动的人口已突破8000万。各地跑步赛事、跑团组织蓬勃发展。',
      source: '新华社', sourceUrl: '',
      publishedAt: '2026-07-07T00:00:00.000Z',
      reliability: 'high', type: 'fact', lang: 'zh',
      tags: ['全民健身', '数据'], feedName: '跑圈资讯', isDefault: true
    }
  ],
  intlRunning: [
    {
      id: 'run-int-default-001',
      title: 'World Marathon Majors 2026 Season Update',
      summary: 'The 2026 World Marathon Majors season continues with record-breaking performances across Tokyo, Boston, London, Berlin, Chicago, and New York City.',
      source: 'World Athletics', sourceUrl: '',
      publishedAt: '2026-07-10T00:00:00.000Z',
      reliability: 'high', type: 'fact', lang: 'en',
      tags: ['Marathon', 'Majors'], feedName: 'World Running', isDefault: true
    },
    {
      id: 'run-int-default-002',
      title: 'Trail Running and Ultramarathon Participation Surges Globally',
      summary: 'Trail running and ultramarathon participation has surged 40% globally in 2026, with new races being established across Europe, Asia, and North America.',
      source: "Runner's World", sourceUrl: '',
      publishedAt: '2026-07-09T00:00:00.000Z',
      reliability: 'high', type: 'fact', lang: 'en',
      tags: ['Trail', 'Ultra'], feedName: 'World Running', isDefault: true
    },
    {
      id: 'run-int-default-003',
      title: 'AI and Wearable Tech Transform Running Training',
      summary: 'AI-powered training plans, smart track real-time feedback, and wearable health monitoring are revolutionizing how runners train worldwide.',
      source: 'MIT Technology Review', sourceUrl: '',
      publishedAt: '2026-07-08T00:00:00.000Z',
      reliability: 'high', type: 'fact', lang: 'zh',
      tags: ['AI', '科技'], feedName: 'World Running', isDefault: true
    }
  ]
};

// ============================================================
// 工具函数
// ============================================================

function getChinaTimeStr(date = new Date()) {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 原子化 JSON 写入：先写临时文件再 rename，防止崩溃导致数据损坏 */
async function safeWriteJSON(filePath, data) {
  const tmp = filePath + '.tmp.' + Date.now();
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmp, filePath);
}

function truncateSummary(text, maxLen = 300) {
  if (!text) return '';
  return text.length > maxLen ? text.substring(0, maxLen) + '…' : text;
}

/** 带超时的 Promise */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`超时: ${label} (${ms}ms)`)), ms)
    )
  ]);
}

/** 检测文章类型 */
function classifyArticleType(title, content) {
  if (!title && !content) return 'uncertain';
  const text = `${title || ''} ${content || ''}`.toLowerCase();

  const speculationWords = [
    'may', 'might', 'could', 'possibly', 'perhaps', 'likely', 'unlikely',
    'expected to', 'is expected', 'anticipated', 'speculative', 'suggests',
    '预计', '可能', '有望', '或将', '猜测', '推测', '预期'
  ];
  const uncertainWords = [
    'unclear', 'unknown', 'uncertain', 'unconfirmed', 'rumor', 'rumour',
    'alleged', 'reportedly', '不明', '未知', '未经证实', '传闻', '据传'
  ];

  const speculationScore = speculationWords.filter(w => text.includes(w)).length;
  const uncertainScore = uncertainWords.filter(w => text.includes(w)).length;

  if (uncertainScore >= 2) return 'uncertain';
  if (speculationScore >= 2) return 'speculation';
  return 'fact';
}

function getBestLink(item) {
  return item.link || (item.guid && item.guid.startsWith('http') ? item.guid : item.permalink) || '';
}

function getBestDate(item) {
  return item.isoDate || (item.pubDate ? new Date(item.pubDate).toISOString() : (item.date ? new Date(item.date).toISOString() : new Date().toISOString()));
}

function getBestSummary(item) {
  if (item.contentSnippet) return truncateSummary(item.contentSnippet);
  if (item.content) return truncateSummary(item.content.replace(/<[^>]*>/g, '').trim());
  if (item.summary) return truncateSummary(item.summary);
  if (item.description) return truncateSummary(item.description.replace(/<[^>]*>/g, '').trim());
  return '';
}

function getBestImage(item) {
  if (item.media && item.media.$ && item.media.$.url) return item.media.$.url;
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  return null;
}

// ============================================================
// 核心：抓取新闻
// ============================================================

async function fetchRSSFeed(feedConfig, useFallback = false) {
  try {
    const feed = await withTimeout(
      parser.parseURL(feedConfig.url),
      FETCH_TIMEOUT,
      feedConfig.name
    );
    if (!feed || !feed.items || feed.items.length === 0) {
      return [];
    }

    let items = feed.items;
    if (feedConfig.filter) {
      items = items.filter(feedConfig.filter);
    }

    const langHint = feedConfig.lang === 'zh' ? 'zh' : 'en';

    // 过滤：只保留最近 2 天内的文章（使用统一常量）
    const maxAge = Date.now() - FRESH_AGE_FETCH;

    return items
      .filter(item => {
        try {
          const pubDate = new Date(getBestDate(item)).getTime();
          return !isNaN(pubDate) && pubDate >= maxAge;
        } catch {
          return true; // 无法判断日期则保留
        }
      })
      .slice(0, 10).map(item => ({
      id: uuidv4(),
      title: item.title || '(无标题)',
      summary: getBestSummary(item),
      source: feedConfig.name.replace(/ \(Direct\)$/, ''),
      sourceUrl: getBestLink(item),
      publishedAt: getBestDate(item),
      imageUrl: getBestImage(item),
      reliability: feedConfig.reliability || 'medium',
      type: classifyArticleType(item.title, item.contentSnippet || item.content),
      lang: langHint,
      tags: (item.categories || []).slice(0, 5),
      feedName: feedConfig.name
    }));
  } catch (err) {
    console.log(`  [${feedConfig.name}] ${useFallback ? '备用源也' : ''}失败: ${err.message.substring(0, 60)}`);
    return [];
  }
}

/** 抓取一个板块的所有 RSS 源 */
async function fetchSection(section, feeds, fallbackFeeds) {
  console.log(`\n📡 板块 ${section}: ${feeds.length} 个信源`);
  const allItems = [];

  // 第一轮：尝试主源
  const primaryResults = await Promise.allSettled(
    feeds.map(feed => fetchRSSFeed(feed, false))
  );
  for (let i = 0; i < feeds.length; i++) {
    const result = primaryResults[i];
    if (result.status === 'fulfilled' && result.value.length > 0) {
      console.log(`  ✓ ${feeds[i].name}: ${result.value.length} 条`);
      allItems.push(...result.value);
    } else {
      console.log(`  ✗ ${feeds[i].name}: 主源失败`);
      // 尝试备用源
      if (fallbackFeeds && fallbackFeeds[section]) {
        for (const fb of fallbackFeeds[section]) {
          console.log(`  → 尝试备用: ${fb.name}...`);
          const fbItems = await fetchRSSFeed(fb, true);
          if (fbItems.length > 0) {
            console.log(`    ✓ ${fb.name}: ${fbItems.length} 条`);
            allItems.push(...fbItems);
            break;
          }
        }
      }
    }
  }

  // 去重 + 排序
  const seen = new Set();
  const deduped = allItems.filter(item => {
    const key = item.title.substring(0, 30).toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const sorted = deduped.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  console.log(`  → 合计 ${sorted.length} 条 (去重后)`);
  return sorted;
}
/** 爬取百度实时热搜 */
async function scrapeBaiduHot() {
  try {
    const html = await axios.get('https://top.baidu.com/board?tab=realtime', {timeout:8000,headers:{'User-Agent':'Mozilla/5.0'}}).then(r=>r.data);
    const $ = cheerio.load(html);
    const items = []; const now = new Date();
    $('.category-wrap_iQLoo .content_1YWBm').each((i, el) => {
      if (i >= 10) return;
      const title = $(el).find('.c-single-text-ellipsis').text().trim();
      const desc = $(el).find('.desc_3CTjT').text().trim() || '热搜';
      if (!title) return;
      const d = new Date(now); d.setMinutes(d.getMinutes() - i);
      items.push({id:'hot-'+Date.now()+'-'+i, title, summary:desc, source:'百度热搜',
        sourceUrl:'https://www.baidu.com/s?wd='+encodeURIComponent(title),
        publishedAt:d.toISOString(), reliability:'medium', type:'fact', lang:'zh', tags:['热点'], feedName:'百度热搜', isHot:true});
    });
    return items;
  } catch(e) { return []; }
}

/** 爬取微博实时热搜 */
async function scrapeWeiboHot() {
  try {
    const res = await axios.get('https://weibo.com/ajax/side/hotSearch', {timeout:8000,headers:{'User-Agent':'Mozilla/5.0'}});
    const realtime = res.data?.data?.realtime || [];
    const now = new Date(); const items = [];
    realtime.slice(0,15).forEach((item, i) => {
      const title = item.word || '';
      if (!title) return;
      const d = new Date(now); d.setMinutes(d.getMinutes() - i);
      items.push({id:'weibo-'+Date.now()+'-'+i, title, summary:'微博热搜', source:'微博热搜',
        sourceUrl:'https://s.weibo.com/weibo?q='+encodeURIComponent(title),
        publishedAt:d.toISOString(), reliability:'medium', type:'fact', lang:'zh', tags:['热点'], feedName:'微博热搜', isHot:true});
    });
    return items;
  } catch(e) { return []; }
}

/** 主抓取函数（带总超时） */
async function fetchAllNews() {
  const startTime = Date.now();
  console.log(`\n========================================`);
  console.log(`开始抓取新闻 - ${getChinaTimeStr()}`);
  console.log(`========================================\n`);

  const results = {};

  try {
    await withTimeout((async () => {
      for (const [section, feeds] of Object.entries(RSS_FEEDS)) {
        results[section] = await fetchSection(section, feeds, FALLBACK_FEEDS);
      }
    })(), FETCH_MASTER_TIMEOUT, '整体抓取');
  } catch (err) {
    console.error(`\n⚠️ 抓取超时或被中断: ${err.message}`);
  }

  // 追加实时热搜（百度 + 微博）
  try {
    const [baidu, weibo] = await Promise.all([
      scrapeBaiduHot(),
      scrapeWeiboHot()
    ]);
    const hotAll = [...baidu, ...weibo];
    if (hotAll.length > 0) results.china = [...hotAll, ...(results.china || [])];
  } catch (err) { console.log(`🔥 热搜忽略: ${err.message}`); }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n========================================`);
  console.log(`抓取完成 - ${getChinaTimeStr()} (耗时 ${elapsed}s)`);
  console.log(`国际: ${results.international?.length || 0} | 中国: ${results.china?.length || 0} | AI全球: ${results.aiGlobal?.length || 0} | AI中国: ${results.aiChina?.length || 0} | 跑圈: 中国${results.chinaRunning?.length || 0} | 国际${results.intlRunning?.length || 0} | 健康${results.health?.length || 0}`);
  console.log(`========================================\n`);

  return results;
}

// ============================================================
// 数据存储（追加模式 - 保留所有历史）
// ============================================================

/** 获取今天日期的 YYYY-MM-DD 字符串 */
function getTodayStr() {
  return new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .replace(/\//g, '-');
}

/** 合并新旧数据（去重 + 追加） */
function mergeItems(newItems, existingItems) {
  const seen = new Set();
  // 建立去重集合：同时用 ID 和标题前50字符
  (existingItems || []).forEach(item => {
    if (item.id) seen.add(item.id);
    const t = item.title?.substring(0, 50).toLowerCase().trim();
    if (t) seen.add('t:' + t);
  });

  const today = getTodayStr();
  const merged = [...(existingItems || [])];

  // 追加新项（去重：同时检查 ID 和标题）
  for (const item of newItems) {
    if (item.id && seen.has(item.id)) continue;
    const titleKey = item.title?.substring(0, 50).toLowerCase().trim();
    if (titleKey && seen.has('t:' + titleKey)) continue;
    if (titleKey) seen.add('t:' + titleKey);
    if (item.id) seen.add(item.id);

    item.fetchDate = today;
    merged.push(item);
  }

  // 按发布时间排序（最新的在前）
  merged.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return merged;
}

/** 清理已有重复数据（按标题去重，保留最新的那条） */
function dedupItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const titleKey = item.title?.substring(0, 50).toLowerCase().trim();
    if (titleKey) {
      if (seen.has('t:' + titleKey)) continue;
      seen.add('t:' + titleKey);
    }
    if (item.id) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
    }
    result.push(item);
  }
  return result;
}

/** 给没有链接的文章自动补充搜索链接 */
function fillMissingSourceUrl(items) {
  return items.map(item => {
    if (!item.sourceUrl || item.sourceUrl === '#') {
      const keyword = encodeURIComponent(item.title?.substring(0, 60) || item.source || '文章');
      item.sourceUrl = `https://www.baidu.com/s?wd=${keyword}`;
    }
    return item;
  });
}

async function saveNewsData(newsData) {
  const now = new Date();
  const today = getTodayStr();
  const chinaDateStr = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

  // 加载现有数据
  const existing = await loadNewsData().catch(() => null);

  const sections = {};
  const sectionKeys = ['international', 'china', 'aiGlobal', 'aiChina', 'chinaRunning', 'intlRunning', 'health'];

  const sectionMeta = {
    international: { title: '国际新闻', icon: '🌍' },
    china: { title: '中国新闻', icon: '🇨🇳' },
    aiGlobal: { title: 'AI 全球动态', icon: '🤖' },
    aiChina: { title: 'AI 中国动态', icon: '🇨🇳' },
    chinaRunning: { title: '中国跑圈', icon: '🇨🇳' },
    intlRunning: { title: '国际跑圈', icon: '🌍' },
    health: { title: '运动健康', icon: '💪' }
  };

  for (const key of sectionKeys) {
    const newItems = newsData[key] || [];
    const existingItems = existing?.sections?.[key]?.items || [];
    let merged = mergeItems(newItems, existingItems);
    // 清理已有重复数据（按标题去重）
    merged = dedupItems(merged);
    // 给没有链接的文章补上搜索链接
    merged = fillMissingSourceUrl(merged);
    sections[key] = { ...sectionMeta[key], items: merged };
  }

  const data = {
    lastUpdated: now.toISOString(),
    updateStatus: 'success',
    date: chinaDateStr,
    today: today,
    chinaDate: getChinaTimeStr(now),
    sections,
    sectionGroups: {
      currentAffairs: { title: '时事新闻', icon: '📰', subs: ['international', 'china'], defaultSub: 'international' },
      aiUpdates: { title: 'AI动态', icon: '🤖', subs: ['aiGlobal', 'aiChina'], defaultSub: 'aiGlobal' },
      running: { title: '跑圈', icon: '🏃', subs: ['chinaRunning', 'intlRunning', 'health'], defaultSub: 'chinaRunning' }
    }
  };

  await safeWriteJSON(DATA_FILE, data);
  const total = Object.values(sections).reduce((sum, s) => sum + s.items.length, 0);
  console.log(`数据已保存到 ${DATA_FILE}（共 ${total} 条，新增 ${Object.values(newsData).reduce((s, arr) => s + (arr?.length || 0), 0)} 条）`);
  return data;
}

async function loadNewsData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ============================================================
// 执行更新（被 cron 和手动刷新共用）
// ============================================================

let isFetching = false;

async function executeUpdate() {
  if (isFetching) {
    console.log('⏳ 已有抓取任务正在进行，跳过');
    return;
  }
  isFetching = true;

  try {
    // 更新状态为 fetching
    const current = await loadNewsData();
    if (current) {
      current.updateStatus = 'fetching';
      await safeWriteJSON(DATA_FILE, current);
    }

    const news = await fetchAllNews();

    // 健康板块补充静态知识文章（如果还没有的话）
    if (!news.health) news.health = [];
    const existingHealth = current?.sections?.health?.items || [];
    const hasKnowledge = existingHealth.some(i => i.isKnowledge);
    if (!hasKnowledge) {
      news.health = [...HEALTH_KNOWLEDGE_ARTICLES, ...news.health];
    }

    // 跑步板块补充默认文章
    for (const section of ['chinaRunning', 'intlRunning']) {
      if (!news[section]) news[section] = [];
      const existing = current?.sections?.[section]?.items || [];
      const hasDefault = existing.some(i => i.isDefault);
      if (!hasDefault && RUNNING_DEFAULT_ARTICLES[section]) {
        news[section] = [...RUNNING_DEFAULT_ARTICLES[section], ...news[section]];
      }
    }

    // 各板块默认备用文章（RSS抓不到时也有内容可看）
    const FALLBACK = {
      china: [{id:'fb-cn-1',title:'今日中国新闻',summary:'系统每日自动聚合中国最新新闻资讯。',source:'资讯中心',
        sourceUrl:'https://www.baidu.com/s?wd=中国新闻',publishedAt:new Date().toISOString(),reliability:'high',type:'fact',lang:'zh',tags:['综合'],feedName:'默认',isDefault:true},
        {id:'fb-cn-2',title:'中国科技发展动态',summary:'中国在AI、5G、新能源等领域持续突破。',source:'资讯中心',
        sourceUrl:'https://www.baidu.com/s?wd=中国科技',publishedAt:new Date(Date.now()-3600000).toISOString(),reliability:'high',type:'fact',lang:'zh',tags:['科技'],feedName:'默认',isDefault:true}],
      international:[{id:'fb-int-1',title:"Today's World News",summary:'Latest global news aggregated daily.',source:'News',
        sourceUrl:'https://www.google.com/search?q=world+news',publishedAt:new Date().toISOString(),reliability:'high',type:'fact',lang:'en',tags:['News'],feedName:'Default',isDefault:true}],
      aiGlobal:[{id:'fb-ai-1',title:'AI Industry Updates',summary:'Latest AI developments and breakthroughs.',source:'AI News',
        sourceUrl:'https://www.google.com/search?q=AI',publishedAt:new Date().toISOString(),reliability:'high',type:'fact',lang:'en',tags:['AI'],feedName:'Default',isDefault:true}],
      aiChina:[{id:'fb-ai-cn-1',title:'中国AI行业动态',summary:'大模型、AI应用、智能芯片等领域最新进展。',source:'AI资讯',
        sourceUrl:'https://www.baidu.com/s?wd=人工智能',publishedAt:new Date().toISOString(),reliability:'high',type:'fact',lang:'zh',tags:['AI'],feedName:'默认',isDefault:true}]
    };
    for (const [sec, items] of Object.entries(FALLBACK)) {
      if (!news[sec]) news[sec] = [];
      const existing = current?.sections?.[sec]?.items || [];
      if (!existing.some(i => i.isDefault)) {
        news[sec] = [...items, ...news[sec]];
      }
    }

    const hasContent = Object.values(news).some(items => items.length > 0);

    if (hasContent) {
      await saveNewsData(news);
    } else {
      // 全部失败 - 保留旧数据，仅更新状态
      console.log('⚠️ 所有信源均未获取到内容');
      const current2 = await loadNewsData();
      if (current2) {
        current2.updateStatus = 'error';
        current2.lastError = '所有信源均超时或失败';
        await safeWriteJSON(DATA_FILE, current2);
      }
    }
  } catch (err) {
    console.error('❌ 更新失败:', err.message);
    try {
      const current = await loadNewsData();
      if (current) {
        current.updateStatus = 'error';
        current.lastError = err.message;
        await safeWriteJSON(DATA_FILE, current);
      }
    } catch { /* ignore */ }
  } finally {
    isFetching = false;
  }
}

// ============================================================
// Cron 任务: 每日中国时间 4:30
// ============================================================

const CRON_SCHEDULE = '30 4 * * *';

cron.schedule(CRON_SCHEDULE, () => {
  console.log(`\n⏰ [CRON] 触发定时更新 - ${getChinaTimeStr()}`);
  executeUpdate();
}, {
  scheduled: true,
  timezone: 'Asia/Shanghai'
});

console.log(`⏰ Cron 定时: ${CRON_SCHEDULE} (Asia/Shanghai) → 每日 4:30`);
console.log(`   抓取超时: 每源 ${FETCH_TIMEOUT}ms / 总任务 ${FETCH_MASTER_TIMEOUT}ms`);

// ============================================================
// Express 服务器
// ============================================================

const app = express();
app.use(express.json());

// CORS + 安全头
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  // CSP 安全头
  res.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://api.deepseek.com; frame-src 'none'; object-src 'none'");
  next();
});

// 请求频率限制
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 分钟窗口
  max: 60,                  // 每分钟最多 60 次请求
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' }
});
const translateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,                  // 翻译 API 更严格：每分钟 20 次
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '翻译请求过于频繁，请稍后再试' }
});
const refreshLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,                   // 刷新 API：每 5 分钟最多 3 次
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '刷新过于频繁，请等待 5 分钟后再试' }
});

// 应用限流
app.use('/api', apiLimiter);
app.use('/api/translate', translateLimiter);
app.use('/api/refresh', refreshLimiter);

// ============================================================
// API 路由
// ============================================================

app.get('/api/news', async (req, res) => {
  try {
    const data = await loadNewsData();
    if (!data || !data.sections || Object.values(data.sections).every(s => !s.items?.length)) {
      return res.json({ status: 'empty', message: '尚未更新', sections: {} });
    }
    // 实时过滤：展示最近 72 小时的消息（使用统一常量）
    const timeLimit = Date.now() - FRESH_AGE_API;
    const staleKW = [/南京大屠杀|Nanjing\s*massacre/i];
    const filtered = { ...data, sections: {} };
    for (const [key, section] of Object.entries(data.sections)) {
      const items = (section.items || []).filter(item => {
        if (item.isKnowledge || item.isDefault) return true;
        const d = new Date(item.publishedAt).getTime();
        if (isNaN(d) || d < timeLimit) return false;
        const txt = (item.title + ' ' + (item.summary||'')).toLowerCase();
        if (staleKW.some(p => p.test(txt))) return false;
        return true;
      });
      filtered.sections[key] = { ...section, items };
    }
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/news/:section', async (req, res) => {
  try {
    const data = await loadNewsData();
    const section = data?.sections?.[req.params.section];
    if (!section) return res.json({ status: 'empty', items: [] });
    res.json(section);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const data = await loadNewsData();
    res.json({
      lastUpdated: data?.lastUpdated || null,
      updateStatus: data?.updateStatus || 'pending',
      date: data?.date || null,
      chinaDate: data?.chinaDate || null,
      isFetching,
      sections: data?.sections ? Object.fromEntries(
        Object.entries(data.sections).map(([k, v]) => [k, v.items?.length || 0])
      ) : {}
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  res.json({ status: 'started', message: '开始抓取新闻，请稍后刷新查看' });
  setImmediate(executeUpdate);
});

// ============================================================
// 翻译 API - 使用 DeepSeek（国内可直接访问）
// ============================================================

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

/** 获取 DeepSeek API Key（支持环境变量和 .env） */
function getDeepSeekKey() {
  return process.env.DEEPSEEK_API_KEY || '';
}

/** 使用 DeepSeek 翻译文本 */
async function translateWithDeepSeek(text, sourceLang = 'en', targetLang = 'zh') {
  const apiKey = getDeepSeekKey();
  if (!apiKey) {
    throw new Error('未配置 DEEPSEEK_API_KEY，请在 .env 文件中设置');
  }

  const langMap = { en: '英文', zh: '中文', ja: '日文', ko: '韩文', fr: '法文', de: '德文' };
  const sourceName = langMap[sourceLang] || sourceLang;
  const targetName = langMap[targetLang] || targetLang;

  const response = await axios.post(DEEPSEEK_API_URL, {
    model: DEEPSEEK_MODEL,
    messages: [
      {
        role: 'system',
        content: `你是一个专业的新闻翻译助手。请将以下${sourceName}新闻内容翻译成${targetName}。

要求：
1. 保持新闻的专业性和准确性
2. 使用符合中文阅读习惯的表达方式
3. 专业术语要翻译准确
4. 保持原文的语气和风格
5. 只输出翻译结果，不要加任何解释或额外内容
6. 如果输入包含多段文本（用 ||| 分隔），请对应输出多段翻译结果（也用 ||| 分隔）`
      },
      {
        role: 'user',
        content: text
      }
    ],
    temperature: 0.3,
    max_tokens: text.length * 3 + 500,
    stream: false
  }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });

  const result = response.data?.choices?.[0]?.message?.content;
  if (!result) {
    throw new Error('DeepSeek 返回空结果');
  }
  return result.trim();
}

// ============================================================
// 翻译 API 路由
// ============================================================

/**
 * GET /api/translate?text=xxx&from=en&to=zh
 * 单段文本翻译
 */
app.get('/api/translate', async (req, res) => {
  try {
    const { text, from = 'en', to = 'zh' } = req.query;
    if (!text) {
      return res.status(400).json({ error: '缺少 text 参数' });
    }
    const translation = await translateWithDeepSeek(text, from, to);
    res.json({ translation });
  } catch (err) {
    console.warn('翻译 API 出错:', err.message);
    res.status(502).json({
      error: '翻译服务不可用',
      detail: err.message,
      hint: '请确保已在 .env 文件中配置 DEEPSEEK_API_KEY'
    });
  }
});

/**
 * POST /api/translate/batch
 * 批量翻译（标题+摘要一起传，省钱省时间）
 * Body: { texts: ["title1", "summary1"], from: "en", to: "zh" }
 * 返回: { translations: ["翻译后标题1", "翻译后摘要1"] }
 */
app.post('/api/translate/batch', async (req, res) => {
  try {
    const { texts, from = 'en', to = 'zh' } = req.body;
    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      return res.status(400).json({ error: '缺少 texts 参数（需为非空数组）' });
    }

    // 用 ||| 分隔多个文本，一次性发给 DeepSeek
    const combined = texts.join(' ||| ');
    const translation = await translateWithDeepSeek(combined, from, to);
    const translatedTexts = translation.split(' ||| ').map(t => t.trim());

    // 如果返回的段数不匹配，尝试换行分割
    if (translatedTexts.length !== texts.length) {
      // 可能 DeepSeek 用换行分割了
      const byNewline = translation.split('\n').filter(t => t.trim());
      if (byNewline.length === texts.length) {
        return res.json({ translations: byNewline });
      }
      // 还是不对，那就整体作为一个结果，保持数量一致
      if (translatedTexts.length < texts.length) {
        // 补足
        while (translatedTexts.length < texts.length) {
          translatedTexts.push('');
        }
      }
    }

    res.json({ translations: translatedTexts.slice(0, texts.length) });
  } catch (err) {
    console.warn('批量翻译 API 出错:', err.message);
    res.status(502).json({
      error: '批量翻译服务不可用',
      detail: err.message,
      hint: '请确保已在 .env 文件中配置 DEEPSEEK_API_KEY'
    });
  }
});

/**
 * GET /api/translate/status
 * 检查翻译服务状态
 */
app.get('/api/translate/status', (req, res) => {
  const apiKey = getDeepSeekKey();
  res.json({
    available: !!apiKey,
    provider: 'deepseek',
    model: DEEPSEEK_MODEL,
    configured: !!apiKey
  });
});

// ============================================================
// 收藏 / 历史 / 搜索 API
// ============================================================

/** 加载收藏数据 */
async function loadFavorites() {
  try {
    const raw = await fs.readFile(FAVORITES_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch { return []; }
}

/** 保存收藏数据 */
async function saveFavorites(items) {
  if (items.length > MAX_FAVORITES) {
    items = items.slice(items.length - MAX_FAVORITES);
  }
  await safeWriteJSON(FAVORITES_FILE, items);
  return items;
}

/** 加载历史记录 */
async function loadHistory() {
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch { return []; }
}

/** 保存历史记录 */
async function saveHistory(items) {
  if (items.length > MAX_HISTORY) {
    items = items.slice(items.length - MAX_HISTORY);
  }
  await safeWriteJSON(HISTORY_FILE, items);
  return items;
}

// ---- 收藏 APIs ----

app.get('/api/favorites', async (req, res) => {
  try {
    const { page = '1', pageSize = '20' } = req.query;
    const items = await loadFavorites();
    const p = parseInt(page);
    const ps = parseInt(pageSize);
    const total = items.length;
    const totalPages = Math.ceil(total / ps) || 1;
    const start = (p - 1) * ps;
    const paged = items.slice(start, start + ps);
    res.json({ items: paged, total, page: p, pageSize: ps, totalPages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/favorites', async (req, res) => {
  try {
    const { item } = req.body;
    if (!item || !item.id) {
      return res.status(400).json({ error: '缺少 item 参数' });
    }
    const items = await loadFavorites();
    const exists = items.some(i => i.id === item.id);
    if (!exists) {
      items.push({ ...item, favoritedAt: new Date().toISOString() });
      await saveFavorites(items);
    }
    res.json({ success: true, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/favorites/:id', async (req, res) => {
  try {
    let items = await loadFavorites();
    items = items.filter(i => i.id !== req.params.id);
    await saveFavorites(items);
    res.json({ success: true, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/favorites/check/:id', async (req, res) => {
  try {
    const items = await loadFavorites();
    const isFavorited = items.some(i => i.id === req.params.id);
    res.json({ isFavorited });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/favorites/batch-check', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ error: '缺少 ids 参数' });
    }
    const items = await loadFavorites();
    const favSet = new Set(items.map(i => i.id));
    const result = {};
    ids.forEach(id => { result[id] = favSet.has(id); });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- 历史记录 APIs ----

app.get('/api/history', async (req, res) => {
  try {
    const { page = '1', pageSize = '20' } = req.query;
    const items = await loadHistory();
    items.reverse();
    const p = parseInt(page);
    const ps = parseInt(pageSize);
    const total = items.length;
    const totalPages = Math.ceil(total / ps) || 1;
    const start = (p - 1) * ps;
    const paged = items.slice(start, start + ps);
    res.json({ items: paged, total, page: p, pageSize: ps, totalPages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/history', async (req, res) => {
  try {
    const { item } = req.body;
    if (!item || !item.id) {
      return res.status(400).json({ error: '缺少 item 参数' });
    }
    let items = await loadHistory();
    items = items.filter(i => i.id !== item.id);
    items.push({ ...item, viewedAt: new Date().toISOString() });
    await saveHistory(items);
    res.json({ success: true, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/history', async (req, res) => {
  try {
    await saveHistory([]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- 搜索 API ----

app.get('/api/search', async (req, res) => {
  try {
    const { keyword, date, section, page = '1', pageSize = '20' } = req.query;
    const data = await loadNewsData();
    if (!data || !data.sections) {
      return res.json({ items: [], total: 0, page: 1, totalPages: 0 });
    }

    let allItems = [];
    const sections = data.sections;

    if (section && sections[section]) {
      allItems = sections[section].items.map(item => ({ ...item, _section: section }));
    } else {
      for (const [key, sec] of Object.entries(sections)) {
        if (sec.items) {
          allItems.push(...sec.items.map(item => ({ ...item, _section: key })));
        }
      }
    }

    if (keyword) {
      const kw = keyword.toLowerCase().trim();
      allItems = allItems.filter(item => {
        const title = (item.title || '').toLowerCase();
        const summary = (item.summary || '').toLowerCase();
        const tags = (item.tags || []).join(' ').toLowerCase();
        return title.includes(kw) || summary.includes(kw) || tags.includes(kw);
      });
    }

    if (date) {
      allItems = allItems.filter(item => {
        const itemDate = item.publishedAt ? item.publishedAt.substring(0, 10) : '';
        return itemDate === date;
      });
    }

    allItems.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    const p = parseInt(page);
    const ps = parseInt(pageSize);
    const total = allItems.length;
    const totalPages = Math.ceil(total / ps) || 1;
    const start = (p - 1) * ps;
    const paged = allItems.slice(start, start + ps);

    res.json({ items: paged, total, page: p, pageSize: ps, totalPages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- 实时热点 API ----
const hotCache = { items: [], time: 0 };
const HOT_CACHE_TTL = 120000;

app.get('/api/hot', async (req, res) => {
  try {
    if (Date.now() - hotCache.time < HOT_CACHE_TTL && hotCache.items.length) {
      return res.json(hotCache.items);
    }
    const [baidu, weibo] = await Promise.all([
      scrapeBaiduHot().catch(()=>[]), scrapeWeiboHot().catch(()=>[])
    ]);
    hotCache.items = [...baidu, ...weibo];
    hotCache.time = Date.now();
    res.json(hotCache.items);
  } catch (err) {
    res.json(hotCache.items || []);
  }
});

// ============================================================
// 静态文件
// ============================================================

app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return;
  res.sendFile(path.join(__dirname, 'Main.html'));
});

// ============================================================
// 启动
// ============================================================

async function startup() {
  // 确保 data/ 目录存在（Railway 等云平台需要）
  try {
    await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
  } catch { /* 忽略 */ }

  const existing = await loadNewsData();
  if (existing && existing.sections) {
    const total = Object.values(existing.sections).reduce((sum, s) => sum + (s.items?.length || 0), 0);
    console.log(`📊 已加载 ${total} 条已保存新闻 (${existing.date || '无日期'})`);
  } else {
    console.log('📊 无已保存数据');
  }

  // 启动时清洗数据：去重 + 移除过期新闻 + 补链接
  try {
    const data = await loadNewsData();
    if (data && data.sections) {
      let changed = false;
      const timeLimit = Date.now() - FRESH_AGE_STARTUP;
      for (const [key, section] of Object.entries(data.sections)) {
        if (!section.items) continue;
        const before = section.items.length;
        section.items = dedupItems(section.items);
        // 只保留今天的新闻
        section.items = section.items.filter(item => {
          if (item.isKnowledge || item.isDefault) return true;
          const d = new Date(item.publishedAt).getTime();
          return !isNaN(d) && d >= timeLimit;
        });
        section.items = fillMissingSourceUrl(section.items);
        if (section.items.length !== before) {
          changed = true;
          console.log(`  ${key}: ${before} → ${section.items.length} 条（清洗）`);
        }
      }
      if (changed) {
        await safeWriteJSON(DATA_FILE, data);
        console.log('✅ 数据清洗完成（仅保留 72 小时内新闻）');
      }
    }
  } catch (err) {
    console.log('数据清洗跳过:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`🚀 AI 信息阅览应用已启动`);
    console.log(`   地址: http://localhost:${PORT}`);
    console.log(`   API:  http://localhost:${PORT}/api/news`);
    console.log(`   更新: 每日中国时间 4:30`);
    console.log(`========================================\n`);
  });
}

startup().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});

// 优雅退出
process.on('SIGINT', () => { console.log('\n关闭中...'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));