import { useEffect, useRef } from 'react'

// A small hand-rolled particle network (canvas, no library) — echoes the
// app's own subject matter (nodes connected into a flow) rather than being
// decoration for its own sake.
interface Particle {
  x: number
  y: number
  vx: number
  vy: number
}

const PARTICLE_COUNT = 70
const LINK_DISTANCE = 140
const SPEED = 0.18

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
    }

    const step = () => {
      ctx.clearRect(0, 0, width, height)
      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < 0 || p.x > width) p.vx *= -1
        if (p.y < 0 || p.y > height) p.vy *= -1
      }
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
      for (const p of particles) {
        ctx.fillStyle = 'rgba(200, 194, 255, 0.6)'
        ctx.beginPath()
        ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2)
        ctx.fill()
      }
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
