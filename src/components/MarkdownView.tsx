/**
 * 极简 Markdown 渲染器
 *
 * 刻意不引入 marked / react-markdown：
 * 本项目只需要支持标题、有序/无序列表、粗体、行内代码这几种语法，
 * 自己实现可以避免为了 5 种语法拉进一整棵依赖树，
 * 同时也让「渲染逻辑」本身成为可读的示例代码。
 */

import type { ReactNode } from 'react'
import { Fragment } from 'react'

/** 处理行内语法：**粗体** 与 `代码` */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  const parts = text.split(pattern).filter((p) => p !== '')

  parts.forEach((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('**') && part.endsWith('**')) {
      nodes.push(<strong key={key}>{part.slice(2, -2)}</strong>)
    } else if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(<code key={key}>{part.slice(1, -1)}</code>)
    } else {
      nodes.push(<Fragment key={key}>{part}</Fragment>)
    }
  })
  return nodes
}

interface Block {
  kind: 'h2' | 'h3' | 'ul' | 'ol' | 'p'
  lines: string[]
}

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = []
  const lines = source.split('\n')

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      continue
    }
    if (line.startsWith('## ')) {
      blocks.push({ kind: 'h2', lines: [line.slice(3)] })
    } else if (line.startsWith('### ')) {
      blocks.push({ kind: 'h3', lines: [line.slice(4)] })
    } else if (/^[-*]\s+/.test(line)) {
      const text = line.replace(/^[-*]\s+/, '')
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'ul') last.lines.push(text)
      else blocks.push({ kind: 'ul', lines: [text] })
    } else if (/^\d+\.\s+/.test(line)) {
      const text = line.replace(/^\d+\.\s+/, '')
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'ol') last.lines.push(text)
      else blocks.push({ kind: 'ol', lines: [text] })
    } else {
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'p') last.lines.push(line)
      else blocks.push({ kind: 'p', lines: [line] })
    }
  }
  return blocks
}

export function MarkdownView({ source }: { source: string }) {
  const blocks = parseBlocks(source)

  return (
    <div className="md">
      {blocks.map((block, index) => {
        const key = `b-${index}`
        if (block.kind === 'h2') {
          return <h3 key={key}>{renderInline(block.lines[0], key)}</h3>
        }
        if (block.kind === 'h3') {
          return <h4 key={key}>{renderInline(block.lines[0], key)}</h4>
        }
        if (block.kind === 'ul') {
          return (
            <ul key={key}>
              {block.lines.map((line, i) => (
                <li key={`${key}-${i}`}>{renderInline(line, `${key}-${i}`)}</li>
              ))}
            </ul>
          )
        }
        if (block.kind === 'ol') {
          return (
            <ol key={key}>
              {block.lines.map((line, i) => (
                <li key={`${key}-${i}`}>{renderInline(line, `${key}-${i}`)}</li>
              ))}
            </ol>
          )
        }
        return (
          <p key={key}>
            {block.lines.map((line, i) => (
              <Fragment key={`${key}-${i}`}>
                {i > 0 && <br />}
                {renderInline(line, `${key}-${i}`)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
