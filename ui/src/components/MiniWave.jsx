export default function MiniWave({ peaks, height = 40 }) {
  if (!peaks?.length) return <div className="miniwave miniwave-empty" style={{ height }} />
  const w = peaks.length
  return (
    <svg className="miniwave" viewBox={`0 0 ${w} 100`} preserveAspectRatio="none" style={{ height }} aria-hidden>
      {peaks.map((p, i) => {
        const h = Math.max(2, p * 96)
        return <rect key={i} x={i + 0.15} y={50 - h / 2} width={0.7} height={h} />
      })}
    </svg>
  )
}
