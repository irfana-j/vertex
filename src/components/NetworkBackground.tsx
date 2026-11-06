import { useEffect, useRef } from 'react'

// A small hand-rolled particle network (canvas, no library) — echoes the
// app's own subject matter (nodes connected into a flow) rather than being
// decoration for its own sake. Most of the time the particles just drift
// and link to nearby neighbors; every so often they're a pun on the app's
// name — "Vertex" — and actually converge into a recognizable polygon/star/
// curve, hold there (slowly rotating), then burst back out to drifting.

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

const PARTICLE_COUNT = 70
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

// ---- shape point generators, all in unit space (roughly radius 1 around the origin) ----

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

type ShapeName = 'hexagon' | 'star' | 'pentagon' | 'triangle' | 'circle' | 'infinity' | 'square' | 'hourglass'
const SHAPES: ShapeName[] = ['hexagon', 'star', 'pentagon', 'triangle', 'circle', 'infinity', 'square', 'hourglass']

function shapePoints(name: ShapeName, count: number): Pt[] {
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

// A few accent colors (as "r,g,b" strings) a formed shape can glow in —
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

    let prevShape: ShapeName | null = null
    let shapeCenter: Pt = { x: 0, y: 0 }
    let shapeRadius = 0
    let shapeRotationBase = 0
    let shapeColor = SHAPE_COLORS[0]
    // baseLocal[particleIndex] = that particle's assigned unit-space shape
    // point; perimeterOrder[k] = which particle owns perimeter point k, so
    // the outline can be traced in the shape's actual edge order.
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
      let next = SHAPES[Math.floor(Math.random() * SHAPES.length)]
      if (next === prevShape) next = SHAPES[(SHAPES.indexOf(next) + 1) % SHAPES.length]
      prevShape = next

      shapeCenter = { x: width * randRange(0.32, 0.68), y: height * randRange(0.3, 0.7) }
      shapeRadius = Math.min(width, height) * randRange(0.16, 0.26)
      shapeRotationBase = randRange(0, Math.PI * 2)
      shapeColor = SHAPE_COLORS[Math.floor(Math.random() * SHAPE_COLORS.length)]

      const basePts = shapePoints(next, PARTICLE_COUNT)
      const initialTargets = basePts.map((p) => rotateScale(p, shapeRotationBase, shapeRadius, shapeCenter))

      // Greedy nearest-neighbor assignment so particles travel to whichever
      // corner of the shape is closest to them, instead of crossing paths.
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
        // Connecting corner-order edges while particles are still scattered
        // across the canvas draws a chaotic tangle, not a forming shape — so
        // the outline only fades in once they're mostly at their targets.
        // Before that, the ordinary proximity links carry the transition.
        const revealStart = 0.65
        if (t < revealStart) {
          drawProximityLines()
        } else {
          drawShapeOutline((t - revealStart) / (1 - revealStart))
        }
        if (t >= 1) {
          phase = 'hold'
          phaseStart = now
          holdDuration = randRange(2200, 3200)
          rotationSpeed = (Math.random() < 0.5 ? -1 : 1) * randRange(0.12, 0.3)
        }
      } else if (phase === 'hold') {
        const angle = shapeRotationBase + ((now - phaseStart) / 1000) * rotationSpeed
        for (let i = 0; i < particles.length; i++) {
          const tgt = rotateScale(baseLocal[i], angle, shapeRadius, shapeCenter)
          particles[i].x = tgt.x
          particles[i].y = tgt.y
        }
        drawShapeOutline(1)
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
        drawShapeOutline(1 - e)
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
