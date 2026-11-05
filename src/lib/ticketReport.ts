import { jsPDF } from 'jspdf'

// What the "Raise ticket" button attaches to the work item it creates — a
// single self-contained PDF carrying everything a reviewer would otherwise
// have to come back into this app to look up: which team owns the
// template, the template/job identity, when that job actually ran, which
// node failed, and its full error log. There's no real screenshot image
// here — Symphony doesn't hand back one, and capturing the browser's own
// UI reliably from a background job isn't practical — so the "error log"
// section below, verbatim and clearly boxed off, is what stands in for it.
export interface FailureReportInput {
  teamName: string | null
  templateName: string
  symphonyTemplateId: string
  jobId: string | number | null
  runTimestamp: number | null
  nodeLabel: string
  nodeService?: string | null
  nodeOperation?: string | null
  scenario: string
  reason?: string | null
  log?: string | null
}

function fmtTimestamp(ts: number | null): string {
  if (!ts) return 'Unknown'
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function buildFailureReportPdf(input: FailureReportInput): Blob {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const marginX = 48
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageBottom = doc.internal.pageSize.getHeight() - 48
  const contentWidth = pageWidth - marginX * 2
  let y = 56

  const ensureRoom = (needed: number) => {
    if (y + needed > pageBottom) {
      doc.addPage()
      y = 56
    }
  }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text('Regression Failure Report', marginX, y)
  y += 20

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(110)
  doc.text(`Generated ${fmtTimestamp(Date.now())} — Vertex Regression Studio`, marginX, y)
  doc.setTextColor(0)
  y += 26

  const field = (label: string, value: string) => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.text(label, marginX, y)
    doc.setFont('helvetica', 'normal')
    const lines = doc.splitTextToSize(value || '—', contentWidth - 130)
    doc.text(lines, marginX + 130, y)
    y += Math.max(16, lines.length * 13)
  }

  field('Team:', input.teamName || 'Unassigned')
  field('Template:', `${input.templateName}${input.symphonyTemplateId ? ` (${input.symphonyTemplateId})` : ''}`)
  field('Job / Run ID:', input.jobId !== null && input.jobId !== undefined ? String(input.jobId) : 'N/A')
  field('Run timestamp:', fmtTimestamp(input.runTimestamp))
  field('Scenario:', input.scenario || '—')
  field('Node:', [input.nodeLabel, input.nodeOperation, input.nodeService].filter(Boolean).join(' · ') || '—')
  y += 8

  doc.setDrawColor(210)
  doc.line(marginX, y, pageWidth - marginX, y)
  y += 22

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text('Failure reason', marginX, y)
  y += 16
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  const reasonLines: string[] = doc.splitTextToSize(input.reason || 'No failure reason captured.', contentWidth)
  reasonLines.forEach((line) => {
    ensureRoom(14)
    doc.text(line, marginX, y)
    y += 13
  })
  y += 14

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text('Error log', marginX, y)
  y += 16
  doc.setFont('courier', 'normal')
  doc.setFontSize(9)
  const logLines: string[] = doc.splitTextToSize(input.log || 'No log captured for this failure.', contentWidth)
  logLines.forEach((line) => {
    ensureRoom(11)
    doc.text(line, marginX, y)
    y += 11
  })

  return doc.output('blob')
}
