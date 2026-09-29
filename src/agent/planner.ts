/**
 * 规划器（Planner）
 *
 * 两条实现路径，输出同一份 PlanNode[] 契约：
 *  - buildMockPlan：基于意图路由的确定性规划，离线可用、结果可复现
 *  - planWithLLM   ：交给真实模型做任务拆解，返回结构化 JSON
 *
 * UI 不区分两者，因此「切换到真实模型」不会改变任何展示逻辑。
 */

import type { LLMConfig, PlanNode } from './types'
import { completeChat } from './llm'

export interface MockToolResult {
  name: string
  text: string
  data?: Record<string, unknown>
}

export interface ComposeContext {
  goal: string
  results: MockToolResult[]
}

export type MockStep =
  | { kind: 'think'; nodeId: string; text: string }
  | { kind: 'tool'; nodeId: string; name: string; args: Record<string, unknown> }
  | { kind: 'answer'; nodeId: string; compose: (ctx: ComposeContext) => string }

export interface MockPlan {
  intent: string
  nodes: PlanNode[]
  steps: MockStep[]
}

function node(id: string, title: string, detail: string, tool?: string): PlanNode {
  return { id, title, detail, status: 'pending', tool }
}

/** 从工具结果里安全取文本，避免 compose 函数因缺字段崩掉 */
function pickText(results: MockToolResult[], name: string): string {
  return results.find((r) => r.name === name)?.text ?? ''
}

const FORECAST_KEYWORDS = ['预测', '出力', '发电', '曲线', '光伏', '精度', '误差', 'nrmse']
const SAVING_KEYWORDS = ['省', '收益', '套利', '回收', '成本', '价差', '投资', '划算', '峰谷']
const KNOWLEDGE_KEYWORDS = [
  '制度', '规则', '流程', '规程', '规范', '要求', '怎么', '如何', '标准', '方案说明', '是什么',
]
const CALC_KEYWORDS = ['计算', '多少钱', '乘以', '加上', '折算']

function detectIntent(goal: string): 'forecast' | 'saving' | 'knowledge' | 'general' {
  const text = goal.toLowerCase()
  if (FORECAST_KEYWORDS.some((k) => text.includes(k))) return 'forecast'
  if (SAVING_KEYWORDS.some((k) => text.includes(k))) return 'saving'
  if (CALC_KEYWORDS.some((k) => text.includes(k)) && /\d/.test(text)) return 'saving'
  if (KNOWLEDGE_KEYWORDS.some((k) => text.includes(k))) return 'knowledge'
  return 'general'
}

/** 从电站名里抽一个像样的名字，抽不到就用默认值 */
function guessStation(goal: string): string {
  const matched = goal.match(/([\u4e00-\u9fa5]{2,10}(?:电站|光伏站|园区|储能站))/)
  return matched ? matched[1] : '南沙园区光伏电站'
}

export function buildMockPlan(goal: string): MockPlan {
  const intent = detectIntent(goal)

  if (intent === 'forecast') {
    const station = guessStation(goal)
    return {
      intent: '光伏出力预测',
      nodes: [
        node('n1', '理解任务目标', '识别为预测类任务，需要产出出力曲线与精度评估'),
        node('n2', '检索预测方法', '在知识库中确认预测口径与误差考核标准', 'knowledge_search'),
        node('n3', '调用预测引擎', `获取「${station}」未来出力预测数据`, 'energy_forecast'),
        node('n4', '生成可视化', '把预测结果渲染成出力曲线'),
        node('n5', '汇总结论建议', '结合误差指标给出可执行建议'),
      ],
      steps: [
        {
          kind: 'think',
          nodeId: 'n1',
          text: `用户要的是「${goal}」。这是预测类任务，我需要三样东西：预测数据本身、行业对预测精度的考核口径、以及偏差的可解释性。先查知识库确认口径，再调预测工具拿数据，最后对照口径给结论。`,
        },
        {
          kind: 'tool',
          nodeId: 'n2',
          name: 'knowledge_search',
          args: { query: '光伏出力预测 误差评估 nRMSE 考核标准', topK: 4 },
        },
        {
          kind: 'think',
          nodeId: 'n2',
          text: '口径确认完毕。接下来调用预测引擎拿具体数据。为了让结果可对比，我同时要预测值和实际值两条曲线。',
        },
        {
          kind: 'tool',
          nodeId: 'n3',
          name: 'energy_forecast',
          args: { station, days: 2, capacity: 20 },
        },
        {
          kind: 'think',
          nodeId: 'n4',
          text: '数据已返回，交给图表渲染。然后我把误差指标和知识库里的考核标准对照一下。',
        },
        {
          kind: 'answer',
          nodeId: 'n5',
          compose: ({ goal: g, results }) => {
            const toolText = pickText(results, 'energy_forecast')
            const knowledge = pickText(results, 'knowledge_search')
            return [
              `## 任务：「${g}」`,
              '',
              '### 一、执行方式',
              '先检索知识库确认预测口径与误差考核标准，再调用预测引擎获取出力数据，最后对照标准评估偏差。',
              '',
              '### 二、预测结果',
              toolText,
              '',
              '### 三、口径依据',
              knowledge
                ? knowledge.split('\n\n')[0]
                : '知识库中未检索到直接相关的口径说明。',
              '',
              '### 四、建议',
              '1. **误差归因优先看时段**：早晚时段的预测误差通常显著高于正午，建议把误差按小时段拆开看，而不是只看全天均值。',
              '2. **接入卫星云图做外推**：云量突变是短期预测的主要误差来源，云团移动轨迹外推能明显改善 0–4 小时窗口的精度。',
              '3. **滚动校正**：对预测结果做分时段偏差校正，并按天在线更新模型参数，避免系统性偏差长期累积。',
              '4. **对照考核线**：短期预测月度 nRMSE 应控制在 10% 以内，如果当前偏差接近或突破该线，需要优先排查气象数据源的时效性。',
            ].join('\n')
          },
        },
      ],
    }
  }

  if (intent === 'saving') {
    return {
      intent: '储能收益测算',
      nodes: [
        node('n1', '理解任务目标', '识别为收益测算类任务，需要量化收益与回收周期'),
        node('n2', '检索优化方案', '确认园区用能成本构成与降本路径', 'knowledge_search'),
        node('n3', '测算套利收益', '按峰谷价差与循环次数测算年化收益', 'peak_valley_saving'),
        node('n4', '生成收益图', '渲染累计收益趋势'),
        node('n5', '汇总结论建议', '给出配置建议与风险提示'),
      ],
      steps: [
        {
          kind: 'think',
          nodeId: 'n1',
          text: `问题是「${goal}」。这类问题的关键在于不能只算电度电价，园区用能成本还有基本电费和力调电费两块，必须一起考虑。先查知识库里的成本构成，再做量化测算。`,
        },
        {
          kind: 'tool',
          nodeId: 'n2',
          name: 'knowledge_search',
          args: { query: '园区用能成本构成 峰谷套利 需量管理 降本路径', topK: 4 },
        },
        {
          kind: 'think',
          nodeId: 'n2',
          text: '成本构成清楚了。下面做定量测算：按 2 MWh 容量、0.9 元峰谷价差、0.88 综合效率、年 330 次循环来算。',
        },
        {
          kind: 'tool',
          nodeId: 'n3',
          name: 'peak_valley_saving',
          args: { capacityMWh: 2, priceGap: 0.9, efficiency: 0.88, cyclesPerYear: 330 },
        },
        {
          kind: 'think',
          nodeId: 'n4',
          text: '收益数据出来了，渲染成累计收益趋势图。同时把需量管理这条容易被忽略的路径也一并说明。',
        },
        {
          kind: 'answer',
          nodeId: 'n5',
          compose: ({ goal: g, results }) => {
            const saving = pickText(results, 'peak_valley_saving')
            const knowledge = pickText(results, 'knowledge_search')
            return [
              `## 任务：「${g}」`,
              '',
              '### 一、测算结果',
              saving,
              '',
              '### 二、成本构成（来自知识库）',
              knowledge ? knowledge.split('\n\n').slice(0, 2).join('\n\n') : '未检索到相关内容。',
              '',
              '### 三、容易被忽略的两条路径',
              '1. **需量管理**：基本电费按最大需量计费，用负荷预测加储能协同把月度峰值削平，见效往往比峰谷套利更快，尤其适合变压器报装容量偏大的园区。',
              '2. **需求响应**：电网发布邀约时，通过削减可调负荷或调用储能放电获取补偿，属于增量收益，不占用日常循环次数。',
              '',
              '### 四、风险提示',
              '- 测算为理论值，实际收益需扣除电池衰减成本与运维成本；',
              '- 峰谷价差会随政策调整，建议按价差下浮 20% 做保守测算；',
              '- 循环次数受实际荷曲线约束，不是想充就能充，需先做负荷匹配分析。',
            ].join('\n')
          },
        },
      ],
    }
  }

  if (intent === 'knowledge') {
    return {
      intent: '知识库问答',
      nodes: [
        node('n1', '理解问题意图', '识别为知识检索类问题，需要给出有依据的回答'),
        node('n2', '检索知识库', '定位相关文档片段并计算相关度', 'knowledge_search'),
        node('n3', '归纳要点', '按重要性重组检索结果，保留引用来源'),
        node('n4', '生成回答', '输出结构化答案并标注出处'),
      ],
      steps: [
        {
          kind: 'think',
          nodeId: 'n1',
          text: `「${goal}」属于需要依据的问题，不能凭记忆答。先检索知识库，拿到原文片段后再归纳。`,
        },
        {
          kind: 'tool',
          nodeId: 'n2',
          name: 'knowledge_search',
          args: { query: goal, topK: 5 },
        },
        {
          kind: 'think',
          nodeId: 'n3',
          text: '检索结果已返回，相关度最高的片段能直接回答主干问题。我按「结论在前、依据在后」的顺序重组，并保留文档出处。',
        },
        {
          kind: 'answer',
          nodeId: 'n4',
          compose: ({ goal: g, results }) => {
            const knowledge = pickText(results, 'knowledge_search')
            return [
              `## 问题：「${g}」`,
              '',
              '### 检索到的依据',
              knowledge,
              '',
              '### 归纳',
              '以上片段按相关度排序，相关度越高的片段建议优先采信。如果问题涉及具体数值口径或考核标准，请以 citation 中的原始文档为准，不要跨文档拼接数字。',
              '',
              '### 下一步',
              '如果这条回答不够具体，可以换一个更聚焦的关键词重试；也可以在左侧「知识库」面板上传你自己的文档，检索会立即覆盖新内容。',
            ].join('\n')
          },
        },
      ],
    }
  }

  return {
    intent: '通用任务',
    nodes: [
      node('n1', '理解任务目标', '拆解需求边界与所需信息'),
      node('n2', '检索相关知识', '从知识库中寻找可复用的依据', 'knowledge_search'),
      node('n3', '时间与计算', '补充时间上下文与数值处理', 'current_time'),
      node('n4', '生成回答', '组织结构化结论'),
    ],
    steps: [
      {
        kind: 'think',
        nodeId: 'n1',
        text: `「${goal}」没有明显的领域特征，我先不急着下结论。策略是：先从知识库找可复用的依据，再补充时间上下文，最后组织答案。`,
      },
      {
        kind: 'tool',
        nodeId: 'n2',
        name: 'knowledge_search',
        args: { query: goal, topK: 4 },
      },
      {
        kind: 'tool',
        nodeId: 'n3',
        name: 'current_time',
        args: {},
      },
      {
        kind: 'think',
        nodeId: 'n3',
        text: '信息收集完成。下面组织回答，并明确标注哪些结论来自知识库、哪些属于模型推断。',
      },
      {
        kind: 'answer',
        nodeId: 'n4',
        compose: ({ goal: g, results }) => {
          const knowledge = pickText(results, 'knowledge_search')
          const time = pickText(results, 'current_time')
          return [
            `## 任务：「${g}」`,
            '',
            `执行时间：${time}`,
            '',
            '### 知识库检索结果',
            knowledge || '未检索到相关内容。',
            '',
            '### 说明',
            '当前以内置知识库为准，未检索到直接依据的部分不做推断。你可以上传自己的文档后重试，检索结果会立即更新。',
          ].join('\n')
        },
      },
    ],
  }
}

/* ------------------------------------------------------------------ */
/* 真实模型规划                                                        */
/* ------------------------------------------------------------------ */

const PLANNER_PROMPT = `你是一个任务规划器。请把用户目标拆解为 3 到 5 个有明确先后顺序的执行步骤。

要求：
1. 只输出 JSON，不要任何解释文字、不要 markdown 代码块。
2. 每步包含 title（不超过 12 字）与 detail（不超过 30 字）。
3. 需要调用工具时，在 tool 字段写上工具名，工具名只能是：knowledge_search、energy_forecast、peak_valley_saving、calculator、current_time。
4. 最后一步通常是汇总结论。

输出格式：
{"nodes":[{"title":"理解目标任务","detail":"拆解需求边界","tool":"knowledge_search"}]}`

export async function planWithLLM(
  config: LLMConfig,
  goal: string,
  signal?: AbortSignal,
): Promise<PlanNode[]> {
  const content = await completeChat(
    config,
    [
      { role: 'system', content: PLANNER_PROMPT },
      { role: 'user', content: goal },
    ],
    signal,
  )

  const json = content.replace(/```json|```/g, '').trim()
  const start = json.indexOf('{')
  const end = json.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('规划器未返回合法的 JSON')

  const parsed = JSON.parse(json.slice(start, end + 1)) as {
    nodes?: { title?: string; detail?: string; tool?: string }[]
  }
  const list = parsed.nodes ?? []
  if (list.length === 0) throw new Error('规划器返回了空的步骤列表')

  return list.map((item, index) =>
    node(
      `n${index + 1}`,
      item.title || `步骤 ${index + 1}`,
      item.detail || '',
      item.tool,
    ),
  )
}
