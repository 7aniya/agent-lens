/**
 * 图表组件
 *
 * 采用 echarts 按需引入（core + 图表 + 组件 + 渲染器），
 * 而不是 `import * as echarts from 'echarts'`，
 * 打包体积可以少一半以上。
 */

import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'
import { useStore } from '../state'
import type { ChartSpec } from '../agent/types'

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
])

const PALETTE = {
  dark: {
    text: '#c6d0dc',
    muted: '#7d8b9c',
    axis: '#2a3242',
    split: '#1c2331',
    series: ['#4cc9f0', '#a78bfa'],
    tooltipBg: '#141a24',
    tooltipBorder: '#2a3242',
  },
  light: {
    text: '#3d4653',
    muted: '#8b95a3',
    axis: '#d8dde5',
    split: '#eef1f5',
    series: ['#0f7fa8', '#6d5bd0'],
    tooltipBg: '#ffffff',
    tooltipBorder: '#dfe4eb',
  },
}

export function ChartView({ spec }: { spec: ChartSpec }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const { state } = useStore()
  const theme = state.theme

  useEffect(() => {
    if (!containerRef.current) return
    const palette = PALETTE[theme]

    const option: EChartsCoreOption = {
      backgroundColor: 'transparent',
      color: palette.series,
      grid: { left: 8, right: 14, top: 38, bottom: 6, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: palette.tooltipBg,
        borderColor: palette.tooltipBorder,
        textStyle: { color: palette.text, fontSize: 12 },
      },
      legend: {
        top: 0,
        right: 0,
        icon: 'roundRect',
        itemWidth: 9,
        itemHeight: 9,
        textStyle: { color: palette.muted, fontSize: 12 },
      },
      xAxis: {
        type: 'category',
        data: spec.categories,
        boundaryGap: spec.type === 'bar',
        axisLine: { lineStyle: { color: palette.axis } },
        axisTick: { show: false },
        axisLabel: { color: palette.muted, fontSize: 11, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        name: spec.unit,
        nameTextStyle: { color: palette.muted, fontSize: 11 },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: palette.split } },
        axisLabel: { color: palette.muted, fontSize: 11 },
      },
      series: spec.series.map((s, index) => ({
        name: s.name,
        type: spec.type,
        data: s.data,
        smooth: spec.type === 'line',
        symbol: 'circle',
        symbolSize: 5,
        barMaxWidth: 26,
        lineStyle: { width: 2 },
        areaStyle:
          spec.type === 'line' && index === 0
            ? { opacity: 0.12 }
            : undefined,
      })),
    }

    if (!chartRef.current) {
      chartRef.current = echarts.init(containerRef.current, undefined, {
        renderer: 'canvas',
      })
    }
    chartRef.current.setOption(option, true)

    const observer = new ResizeObserver(() => chartRef.current?.resize())
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [spec, theme])

  useEffect(() => {
    return () => {
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [])

  return (
    <div className="chart-card">
      <div className="chart-title">{spec.title}</div>
      <div ref={containerRef} className="chart-canvas" />
    </div>
  )
}
