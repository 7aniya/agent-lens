import { useEffect, useState } from 'react'
import { useStore } from '../state'
import { useAgentRun } from '../hooks/useAgentRun'

const EXAMPLES = [
  {
    label: '出力预测',
    goal: '南沙园区光伏电站未来两天的出力预测，并评估预测精度',
  },
  {
    label: '收益测算',
    goal: '2MWh 储能在 0.9 元峰谷价差下，一年能省多少钱',
  },
  {
    label: '知识问答',
    goal: '储能电站热失控的早期预警依据和处置流程是什么',
  },
  {
    label: '通用任务',
    goal: '园区用能成本由哪几部分构成，各自怎么优化',
  },
]

export function GoalComposer() {
  const { state, dispatch } = useStore()
  const { start, cancel, isRunning } = useAgentRun()
  const [value, setValue] = useState('')

  useEffect(() => {
    setValue(state.goal)
  }, [state.goal])

  const submit = () => {
    if (isRunning || !value.trim()) return
    void start(value)
  }

  return (
    <div className="composer">
      <div className="composer-examples">
        <span className="composer-examples-label">示例目标</span>
        {EXAMPLES.map((example) => (
          <button
            key={example.label}
            type="button"
            className="chip"
            disabled={isRunning}
            onClick={() => setValue(example.goal)}
          >
            {example.label}
          </button>
        ))}
        <span className="composer-spacer" />
        <button
          type="button"
          className="link-btn"
          disabled={isRunning || state.timeline.length === 0}
          onClick={() => dispatch({ type: 'reset_run' })}
        >
          清空执行流
        </button>
      </div>

      <div className="composer-row">
        <textarea
          className="composer-input"
          value={value}
          rows={1}
          placeholder="描述一个目标，例如：分析储能电站热失控的预警依据与处置流程"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          spellCheck={false}
        />
        {isRunning ? (
          <button type="button" className="btn btn-danger" onClick={cancel}>
            停止
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!value.trim()}>
            运行
          </button>
        )}
      </div>
    </div>
  )
}
