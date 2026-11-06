import { useEffect, useRef, useState } from 'react'

interface DonutProps {
  percent: number
  size?: number
  strokeWidth?: number
  color?: string
  trackColor?: string
  label?: string
}

export default function Donut({ percent, size = 96, strokeWidth = 10, color = 'var(--primary)', trackColor = 'var(--border)', label }: DonutProps) {
  // Starts at 0 and animates up to the real value on mount (via the
  // stroke-dasharray transition below), rather than just appearing already
  // full — a chart that's already finished isn't nearly as satisfying to
  // look at as one filling in. Later percent changes (a sync landing new
  // results) still animate too, since this is the same transition either way.
  const [display, setDisplay] = useState(0)
  const mounted = useRef(false)

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      const raf = requestAnimationFrame(() => setDisplay(percent))
      return () => cancelAnimationFrame(raf)
    }
    setDisplay(percent)
  }, [percent])

  const r = (size - strokeWidth) / 2
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, display))
  const dash = (clamped / 100) * c

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
      {/* Always mounted (never conditionally added/removed) — a transition
          only animates an existing element's own property change, so this
          has to be the SAME <circle> throughout, going from a 0-length dash
          to the real one, not a fresh element that only ever exists already
          full. */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={`${dash} ${c - dash}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray 0.7s cubic-bezier(0.22, 1, 0.36, 1)' }}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={size * 0.22}
        fontWeight="800"
        fill="var(--text)"
        fontFamily="Manrope, sans-serif"
      >
        {label ?? `${Math.max(0, Math.min(100, percent))}%`}
      </text>
    </svg>
  )
}
