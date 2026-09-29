import { useStore } from '../state'

/**
 * 历史记录条目末尾的删除按钮。
 *
 * 「历史运行」抽屉与右侧可观测性面板各有一份记录列表，展示的是同一份数据，
 * 因此删除能力也必须是同一个组件——否则会出现「一个列表能删、另一个不能删」
 * 的不一致，用户会以为另一个列表里的记录删不掉。
 *
 * 单条删除只影响 records 数组；若被删的这条正被回放展示，
 * 当前视图保持不动（回放的是快照，与列表是否留底无关）。
 */
export function RecordDeleteButton({ id, goal }: { id: string; goal: string }) {
  const { dispatch } = useStore()

  return (
    <button
      type="button"
      className="record-del"
      onClick={() => dispatch({ type: 'delete_record', id })}
      aria-label={`删除记录：${goal}`}
      title="删除这条记录"
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        aria-hidden
      >
        <path d="M4.5 7h15" strokeLinecap="round" />
        <path d="M9.6 7V5.6A1.6 1.6 0 0 1 11.2 4h1.6a1.6 1.6 0 0 1 1.6 1.6V7" strokeLinecap="round" />
        <path d="M6.6 7l.75 11.1A2 2 0 0 0 9.35 20h5.3a2 2 0 0 0 2-1.9L17.4 7" strokeLinejoin="round" />
        <path d="M10.4 11v5.2M13.6 11v5.2" strokeLinecap="round" />
      </svg>
    </button>
  )
}
