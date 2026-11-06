import { useEffect, useRef } from 'react'

// A small hand-rolled particle network (canvas, no library) — echoes the
// app's own subject matter (nodes connected into a flow) rather than being
// decoration for its own sake. Most of the time the particles just drift
// and link to nearby neighbors; every so often they converge into either a
// recognizable polygon/star/curve (slowly rotating while held) or one of a
// few brand words traced in particles — a pun on the app's own name,
// "Vertex" — then burst back out to drifting.

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
}

interface Pt {
  x: number
  y: number
}

const PARTICLE_COUNT = 240
const LINK_DISTANCE = 140
const SPEED = 0.18

const CONVERGE_MS = 1500
const RELEASE_MS = 1100
const BURST_DISTANCE = 140
const BURST_SPEED_MULT = 2.4

const randRange = (min: number, max: number) => min + Math.random() * (max - min)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3

// ---- polygon/curve point generators, all in unit space (roughly radius 1 around the origin) ----

function regularPolygonCorners(sides: number, startAngle = -Math.PI / 2): Pt[] {
  return Array.from({ length: sides }, (_, i) => {
    const a = startAngle + (i / sides) * Math.PI * 2
    return { x: Math.cos(a), y: Math.sin(a) }
  })
}

function starCorners(points: number, outerR: number, innerR: number, startAngle = -Math.PI / 2): Pt[] {
  return Array.from({ length: points * 2 }, (_, i) => {
    const r = i % 2 === 0 ? outerR : innerR
    const a = startAngle + (i / (points * 2)) * Math.PI * 2
    return { x: Math.cos(a) * r, y: Math.sin(a) * r }
  })
}

const HOURGLASS_CORNERS: Pt[] = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 0, y: 0 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
  { x: 0, y: 0 },
]

// Evenly spaces `count` points along the perimeter of a closed polygon, so a
// shape with only a handful of corners still gets traced by every particle.
function perimeterPoints(corners: Pt[], count: number): Pt[] {
  const edges = corners.map((a, i) => {
    const b = corners[(i + 1) % corners.length]
    return { a, b, len: Math.hypot(b.x - a.x, b.y - a.y) }
  })
  const total = edges.reduce((sum, e) => sum + e.len, 0)
  const out: Pt[] = []
  for (let i = 0; i < count; i++) {
    let along = (i / count) * total
    const edge = edges.find((e) => (along -= e.len) <= 0) ?? edges[edges.length - 1]
    along += edge.len
    const t = edge.len === 0 ? 0 : along / edge.len
    out.push({ x: lerp(edge.a.x, edge.b.x, t), y: lerp(edge.a.y, edge.b.y, t) })
  }
  return out
}

function circlePoints(count: number): Pt[] {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2
    return { x: Math.cos(a), y: Math.sin(a) }
  })
}

function infinityPoints(count: number): Pt[] {
  return Array.from({ length: count }, (_, i) => {
    const t = (i / count) * Math.PI * 2
    const scale = 1 / (1 + Math.sin(t) ** 2)
    return { x: Math.cos(t) * scale, y: Math.sin(t) * Math.cos(t) * scale }
  })
}

type PolygonName = 'hexagon' | 'star' | 'pentagon' | 'triangle' | 'circle' | 'infinity' | 'square' | 'hourglass'

function polygonPoints(name: PolygonName, count: number): Pt[] {
  switch (name) {
    case 'hexagon':
      return perimeterPoints(regularPolygonCorners(6), count)
    case 'pentagon':
      return perimeterPoints(regularPolygonCorners(5), count)
    case 'triangle':
      return perimeterPoints(regularPolygonCorners(3), count)
    case 'square':
      return perimeterPoints(regularPolygonCorners(4, -Math.PI / 4), count)
    case 'star':
      return perimeterPoints(starCorners(5, 1, 0.45), count)
    case 'hourglass':
      return perimeterPoints(HOURGLASS_CORNERS, count)
    case 'circle':
      return circlePoints(count)
    case 'infinity':
      return infinityPoints(count)
  }
}

// Renders `text` to an offscreen canvas and samples its filled pixels down
// to `count` points — a dot-matrix version of the word, not an outline, so
// it still reads correctly instead of looking like a tangle of handwriting.
// Points come back normalized the same way polygons are (roughly unit
// scale), plus `aspect` — how many "radii" wide the word is relative to
// tall — since a word is nowhere near circular.
function textPoints(text: string, count: number): { points: Pt[]; aspect: number } {
  const W = 700
  const H = 220
  const off = document.createElement('canvas')
  off.width = W
  off.height = H
  const octx = off.getContext('2d')
  if (!octx) return { points: [{ x: 0, y: 0 }], aspect: 1 }

  octx.clearRect(0, 0, W, H)
  octx.fillStyle = '#fff'
  octx.textAlign = 'center'
  octx.textBaseline = 'middle'
  // A generic system font, not the app's own webfont — this only needs to
  // produce a bold, legible silhouette to sample dots from, and sidesteps
  // any race with the real font still loading when this first runs.
  let fontSize = 160
  const setFont = () => {
    octx.font = `800 ${fontSize}px "Segoe UI", Arial, sans-serif`
  }
  setFont()
  const maxW = W * 0.92
  const measured = octx.measureText(text).width
  if (measured > maxW) fontSize = Math.max(24, Math.floor(fontSize * (maxW / measured)))
  setFont()
  octx.fillText(text, W / 2, H / 2)

  const { data } = octx.getImageData(0, 0, W, H)
  const isOn = (x: number, y: number) => data[(y * W + x) * 4 + 3] > 120

  let step = 4
  let candidates: Pt[] = []
  for (let attempt = 0; attempt < 5 && candidates.length < count; attempt++) {
    candidates = []
    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        if (isOn(x, y)) candidates.push({ x, y })
      }
    }
    step = Math.max(1, step - 1)
  }
  if (candidates.length === 0) candidates = [{ x: W / 2, y: H / 2 }]

  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }
  const chosen = Array.from({ length: count }, (_, i) => candidates[i % candidates.length])

  const xs = chosen.map((p) => p.x)
  const ys = chosen.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const halfH = Math.max(1, (maxY - minY) / 2)

  const points = chosen.map((p) => ({ x: (p.x - cx) / halfH, y: (p.y - cy) / halfH }))
  const aspect = Math.max(1, (maxX - minX) / 2 / halfH)
  return { points, aspect }
}

// What the particles converge into — a polygon/curve (rotates while held)
// or a word (stays upright and static so it's actually readable). Each
// pick, a cycle through this list, not the same one twice in a row.
type ShapeEntry = { kind: 'polygon'; name: PolygonName } | { kind: 'word'; text: string }
const SHAPE_ENTRIES: ShapeEntry[] = [
  { kind: 'polygon', name: 'hexagon' },
  { kind: 'polygon', name: 'star' },
  { kind: 'polygon', name: 'pentagon' },
  { kind: 'word', text: 'Symphony' },
  { kind: 'polygon', name: 'triangle' },
  { kind: 'word', text: 'Regression' },
  { kind: 'polygon', name: 'circle' },
  { kind: 'polygon', name: 'infinity' },
  { kind: 'word', text: 'Vertex' },
  { kind: 'polygon', name: 'square' },
  { kind: 'polygon', name: 'hourglass' },
]

// A few accent colors (as "r,g,b" strings) a formed shape/word can glow in —
// cycled randomly so it's not the same look every time.
const SHAPE_COLORS = ['157,148,255', '122,209,255', '255,143,216', '94,234,212', '255,196,125']

function rotateScale(p: Pt, angle: number, radius: number, center: Pt): Pt {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const x = p.x * cos - p.y * sin
  const y = p.x * sin + p.y * cos
  return { x: center.x + x * radius, y: center.y + y * radius }
}

export default function NetworkBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let width = 0
    let height = 0
    let particles: Particle[] = []
    let frameId = 0

    // Free-drift <-> formed-shape state machine. Phase timings/targets are
    // plain mutable locals (not React state) since they're read/written
    // every animation frame.
    type Phase = 'drift' | 'converge' | 'hold' | 'release'
    let phase: Phase = 'drift'
    let phaseStart = 0
    let driftDuration = randRange(2800, 4200)
    let holdDuration = 0
    let rotationSpeed = 0

    let prevEntryIndex = -1
    let isWord = false
    let wordText = ''
    let wordFontPx = 0
    let shapeCenter: Pt = { x: 0, y: 0 }
    let shapeRadius = 0
    let shapeRotationBase = 0
    let shapeColor = SHAPE_COLORS[0]
    // baseLocal[particleIndex] = that particle's assigned unit-space target
    // point; perimeterOrder[k] = which particle owns perimeter point k, so a
    // polygon's outline can be traced in its actual edge order (unused for
    // words, which are drawn as dots rather than a connected outline).
    let baseLocal: Pt[] = []
    let perimeterOrder: number[] = []
    let convergeFrom: Pt[] = []
    let releaseFrom: Pt[] = []
    let releaseBurst: { x: number; y: number; dx: number; dy: number }[] = []

    const init = () => {
      width = canvas.parentElement?.clientWidth || window.innerWidth
      height = canvas.parentElement?.clientHeight || window.innerHeight
      canvas.width = width
      canvas.height = height
      particles = Array.from({ length: PARTICLE_COUNT }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * SPEED,
        vy: (Math.random() - 0.5) * SPEED,
      }))
      phase = 'drift'
      phaseStart = performance.now()
      driftDuration = randRange(2800, 4200)
    }

    const startConverge = (now: number) => {
      let nextIndex = Math.floor(Math.random() * SHAPE_ENTRIES.length)
      if (nextIndex === prevEntryIndex) nextIndex = (nextIndex + 1) % SHAPE_ENTRIES.length
      prevEntryIndex = nextIndex
      const entry = SHAPE_ENTRIES[nextIndex]
      isWord = entry.kind === 'word'
      shapeColor = SHAPE_COLORS[Math.floor(Math.random() * SHAPE_COLORS.length)]

      let basePts: Pt[]
      if (entry.kind === 'polygon') {
        basePts = polygonPoints(entry.name, PARTICLE_COUNT)
        shapeRotationBase = randRange(0, Math.PI * 2)
        shapeCenter = { x: width * randRange(0.32, 0.68), y: height * randRange(0.3, 0.7) }
        shapeRadius = Math.min(width, height) * randRange(0.16, 0.26)
      } else {
        const { points, aspect } = textPoints(entry.text, PARTICLE_COUNT)
        basePts = points
        shapeRotationBase = 0
        wordText = entry.text
        let radius = Math.min(width, height) * 0.17
        const maxHalfWidth = width * 0.34
        if (radius * aspect > maxHalfWidth) radius = maxHalfWidth / aspect
        shapeRadius = radius
        // Calibrated against textPoints' own offscreen font size (160px
        // mapped to a ~1-unit half-height) so the crisp label lines up with
        // where the particles actually land.
        wordFontPx = radius * 1.85
        const halfW = radius * aspect
        const halfH = radius
        shapeCenter = {
          x: Math.min(Math.max(width * randRange(0.42, 0.58), halfW + 24), width - halfW - 24),
          y: Math.min(Math.max(height * randRange(0.32, 0.68), halfH + 24), height - halfH - 24),
        }
      }

      const initialTargets = basePts.map((p) => rotateScale(p, shapeRotationBase, shapeRadius, shapeCenter))

      // Greedy nearest-neighbor assignment so particles travel to whichever
      // target point is closest to them, instead of crossing paths.
      const used = new Array(PARTICLE_COUNT).fill(false)
      const assignment = new Array(PARTICLE_COUNT).fill(0)
      for (let i = 0; i < particles.length; i++) {
        let best = -1
        let bestDist = Infinity
        for (let k = 0; k < initialTargets.length; k++) {
          if (used[k]) continue
          const d = Math.hypot(particles[i].x - initialTargets[k].x, particles[i].y - initialTargets[k].y)
          if (d < bestDist) {
            bestDist = d
            best = k
          }
        }
        used[best] = true
        assignment[i] = best
      }

      baseLocal = particles.map((_, i) => basePts[assignment[i]])
      perimeterOrder = new Array(PARTICLE_COUNT)
      for (let i = 0; i < particles.length; i++) perimeterOrder[assignment[i]] = i

      convergeFrom = particles.map((p) => ({ x: p.x, y: p.y }))
      phase = 'converge'
      phaseStart = now
    }

    const drawParticles = () => {
      for (const p of particles) {
        ctx.fillStyle = 'rgba(200, 194, 255, 0.65)'
        ctx.beginPath()
        ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const drawProximityLines = () => {
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i]
          const b = particles[j]
          const dist = Math.hypot(a.x - b.x, a.y - b.y)
          if (dist < LINK_DISTANCE) {
            ctx.strokeStyle = `rgba(157, 148, 255, ${0.18 * (1 - dist / LINK_DISTANCE)})`
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }
    }

    const drawShapeOutline = (opacity: number) => {
      ctx.lineWidth = 1.4
      ctx.strokeStyle = `rgba(${shapeColor}, ${0.55 * opacity})`
      ctx.shadowColor = `rgba(${shapeColor}, ${0.85 * opacity})`
      ctx.shadowBlur = 12
      ctx.beginPath()
      for (let k = 0; k < perimeterOrder.length; k++) {
        const p = particles[perimeterOrder[k]]
        if (k === 0) ctx.moveTo(p.x, p.y)
        else ctx.lineTo(p.x, p.y)
      }
      ctx.closePath()
      ctx.stroke()
      ctx.shadowBlur = 0
    }

    // A scattering of particles alone doesn't reliably read as a specific
    // word — so the word itself is drawn as a soft, real glyph render (always
    // legible), with the particles glowing on top of/around it as sparkle
    // rather than being the sole thing spelling it out.
    const drawWordLabel = (opacity: number) => {
      ctx.save()
      ctx.font = `800 ${wordFontPx}px "Segoe UI", Arial, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = `rgba(${shapeColor}, ${0.26 * opacity})`
      ctx.shadowColor = `rgba(${shapeColor}, ${0.55 * opacity})`
      ctx.shadowBlur = 22
      ctx.fillText(wordText, shapeCenter.x, shapeCenter.y)
      ctx.restore()
    }

    const drawWordGlow = (opacity: number) => {
      drawWordLabel(opacity)
      ctx.fillStyle = `rgba(${shapeColor}, ${0.9 * opacity})`
      ctx.shadowColor = `rgba(${shapeColor}, ${opacity})`
      ctx.shadowBlur = 7
      for (const p of particles) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.shadowBlur = 0
    }

    const drawFormed = (opacity: number) => {
      if (isWord) drawWordGlow(opacity)
      else drawShapeOutline(opacity)
    }

    const step = (now: number) => {
      ctx.clearRect(0, 0, width, height)

      if (phase === 'drift') {
        for (const p of particles) {
          p.x += p.vx
          p.y += p.vy
          if (p.x < 0 || p.x > width) p.vx *= -1
          if (p.y < 0 || p.y > height) p.vy *= -1
        }
        drawProximityLines()
        if (now - phaseStart > driftDuration) startConverge(now)
      } else if (phase === 'converge') {
        const t = Math.min(1, (now - phaseStart) / CONVERGE_MS)
        const e = easeInOutCubic(t)
        for (let i = 0; i < particles.length; i++) {
          const tgt = rotateScale(baseLocal[i], shapeRotationBase, shapeRadius, shapeCenter)
          particles[i].x = lerp(convergeFrom[i].x, tgt.x, e)
          particles[i].y = lerp(convergeFrom[i].y, tgt.y, e)
        }
        // Connecting/highlighting points in target order while particles are
        // still scattered across the canvas draws a chaotic tangle, not a
        // forming shape — so the reveal only fades in once they're mostly at
        // their targets. Before that, the ordinary proximity links carry it.
        const revealStart = 0.65
        if (t < revealStart) {
          drawProximityLines()
        } else {
          drawFormed((t - revealStart) / (1 - revealStart))
        }
        if (t >= 1) {
          phase = 'hold'
          phaseStart = now
          holdDuration = isWord ? randRange(2800, 3800) : randRange(2200, 3200)
          rotationSpeed = isWord ? 0 : (Math.random() < 0.5 ? -1 : 1) * randRange(0.12, 0.3)
        }
      } else if (phase === 'hold') {
        const angle = shapeRotationBase + ((now - phaseStart) / 1000) * rotationSpeed
        for (let i = 0; i < particles.length; i++) {
          const tgt = rotateScale(baseLocal[i], angle, shapeRadius, shapeCenter)
          particles[i].x = tgt.x
          particles[i].y = tgt.y
        }
        drawFormed(1)
        if (now - phaseStart > holdDuration) {
          releaseFrom = particles.map((p) => ({ x: p.x, y: p.y }))
          releaseBurst = particles.map((p) => {
            const dx = p.x - shapeCenter.x
            const dy = p.y - shapeCenter.y
            const len = Math.hypot(dx, dy) || 1
            const ndx = dx / len
            const ndy = dy / len
            return { x: p.x + ndx * BURST_DISTANCE, y: p.y + ndy * BURST_DISTANCE, dx: ndx, dy: ndy }
          })
          phase = 'release'
          phaseStart = now
        }
      } else {
        const t = Math.min(1, (now - phaseStart) / RELEASE_MS)
        const e = easeOutCubic(t)
        for (let i = 0; i < particles.length; i++) {
          particles[i].x = lerp(releaseFrom[i].x, releaseBurst[i].x, e)
          particles[i].y = lerp(releaseFrom[i].y, releaseBurst[i].y, e)
        }
        drawFormed(1 - e)
        if (t >= 1) {
          for (let i = 0; i < particles.length; i++) {
            particles[i].vx = releaseBurst[i].dx * SPEED * BURST_SPEED_MULT
            particles[i].vy = releaseBurst[i].dy * SPEED * BURST_SPEED_MULT
          }
          phase = 'drift'
          phaseStart = now
          driftDuration = randRange(4500, 7000)
        }
      }

      drawParticles()
      frameId = requestAnimationFrame(step)
    }

    init()
    frameId = requestAnimationFrame(step)
    window.addEventListener('resize', init)
    return () => {
      cancelAnimationFrame(frameId)
      window.removeEventListener('resize', init)
    }
  }, [])

  return <canvas ref={canvasRef} className="network-bg" />
}
