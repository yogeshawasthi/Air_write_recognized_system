import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { FiSearch } from 'react-icons/fi'
import { User } from 'lucide-react'
import jsPDF from 'jspdf'
import { Hands } from '@mediapipe/hands'
import { Camera } from '@mediapipe/camera_utils'
import api from '../api/axios.js'

// ── Timing constants ──────────────────────────────────────
const LETTER_PAUSE_MS    = 1500   // stillness → confirm letter
const WORD_PAUSE_MS      = 4000   // stillness → finish word
const COOLDOWN_MS        = 1000   // gap between letters (canvas blocked)
const MOVEMENT_THRESHOLD = 5      // px — min movement to count as drawing
const REDRAW_CONF_THRESHOLD = 0.40  // below this → ask user to redraw

export default function LiveWriting() {
  const navigate = useNavigate()

  // ── Refs (don't cause re-renders) ────────────────────────
  const videoRef        = useRef(null)
  const drawCanvasRef   = useRef(null)   // visible stroke canvas
  const sendCanvasRef   = useRef(null)   // hidden canvas for backend
  const prevPointRef    = useRef(null)
  const letterTimerRef  = useRef(null)
  const wordTimerRef    = useRef(null)
  const cooldownRef     = useRef(false)  // true during gap between letters
  const hasStrokeRef    = useRef(false)
  const wordBufferRef   = useRef('')
  const cameraRef       = useRef(null)
  const handsRef        = useRef(null)
  const timerIvRef      = useRef(null)
  const sessionStartRef = useRef(null)
  const spaceLatchedRef = useRef(false)
  const eraseLatchedRef = useRef(false)
  const fistLatchedRef  = useRef(false)
  const noHandTimerRef  = useRef(null)   // fires finishWord when hand absent 4 s

  // ── State ─────────────────────────────────────────────────
  const [isRunning,       setIsRunning]       = useState(false)
  const [handDetected,    setHandDetected]    = useState(false)
  const [mlStatus,        setMlStatus]        = useState('checking')
  const [statusLabel,     setStatusLabel]     = useState('Idle')
  const [pageTitle,       setPageTitle]       = useState('Live Write')  // editable session title
  const [wordSoFar,       setWordSoFar]       = useState('')
  const [lastChar,        setLastChar]        = useState('')
  const [lastConf,        setLastConf]        = useState(null)
  const [top3,            setTop3]            = useState([])
  const [lowConf,         setLowConf]         = useState(false)
  const [sessionText,     setSessionText]     = useState('')
  const [sessionStats,    setSessionStats]    = useState({ chars: 0, words: 0, time: '00:00' })
  const [savedMsg,        setSavedMsg]        = useState('')
  const [errorMsg,        setErrorMsg]        = useState('')
  const [isCooldown,      setIsCooldown]      = useState(false)
  const [cooldownSecs,    setCooldownSecs]    = useState(0)
  const [spaceFlash,      setSpaceFlash]      = useState(false)
  const [eraseFlash,      setEraseFlash]      = useState(false)
  const [fistFlash,       setFistFlash]       = useState(false)
  const [gestureLabel,    setGestureLabel]    = useState('')
  const [noHandSecs,      setNoHandSecs]      = useState(0)    // countdown while hand is absent

  // Redraw prompt
  const [showRedrawPrompt, setShowRedrawPrompt] = useState(false)
  const [redrawTop3,       setRedrawTop3]       = useState([])
  const [redrawAttempts,   setRedrawAttempts]   = useState(0)

  // Save dialog
  const [showSaveDialog,  setShowSaveDialog]  = useState(false)
  const [noteTitle,       setNoteTitle]       = useState('')
  const [pendingWord,     setPendingWord]     = useState('')
  const [saving,          setSaving]          = useState(false)

  // ── ML health check ──────────────────────────────────────
  useEffect(() => {
    api.get('/predict/health', { withCredentials: true })
      .then(r => {
        setMlStatus('online')
        console.log('[ML] Health:', r.data)
      })
      .catch(() => setMlStatus('offline'))
  }, [])

  // ── Session timer ─────────────────────────────────────────
  const startTimer = useCallback(() => {
    sessionStartRef.current = Date.now()
    timerIvRef.current = setInterval(() => {
      const s  = Math.floor((Date.now() - sessionStartRef.current) / 1000)
      const mm = String(Math.floor(s / 60)).padStart(2, '0')
      const ss = String(s % 60).padStart(2, '0')
      setSessionStats(p => ({ ...p, time: `${mm}:${ss}` }))
    }, 1000)
  }, [])

  const stopTimer = useCallback(() => {
    if (timerIvRef.current) clearInterval(timerIvRef.current)
  }, [])

  // ── Clear the draw canvas ─────────────────────────────────
  const clearDrawCanvas = useCallback(() => {
    const canvas = drawCanvasRef.current
    if (!canvas) return
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
    hasStrokeRef.current = false
    prevPointRef.current = null
  }, [])

  // ── Start cooldown period between letters ─────────────────
  const startCooldown = useCallback(() => {
    cooldownRef.current = true
    setIsCooldown(true)
    setCooldownSecs(Math.ceil(COOLDOWN_MS / 1000))
    clearDrawCanvas()

    // Countdown display
    let remaining = COOLDOWN_MS
    const iv = setInterval(() => {
      remaining -= 250
      setCooldownSecs(Math.ceil(remaining / 1000))
      if (remaining <= 0) {
        clearInterval(iv)
        cooldownRef.current = false
        setIsCooldown(false)
        setCooldownSecs(0)
        setStatusLabel('Writing')
      }
    }, 250)
  }, [clearDrawCanvas])

  // ── Dismiss redraw prompt and clear canvas for retry ──────
  const handleRedraw = useCallback(() => {
    setShowRedrawPrompt(false)
    setRedrawTop3([])
    clearDrawCanvas()
    setStatusLabel('Writing')
    // Don't start cooldown — user needs to draw immediately
  }, [clearDrawCanvas])

  // ── Accept a top-3 suggestion from the redraw prompt ──────
  const handlePickSuggestion = useCallback((char) => {
    setShowRedrawPrompt(false)
    setRedrawTop3([])
    setRedrawAttempts(0)
    wordBufferRef.current += char
    setWordSoFar(wordBufferRef.current)
    setLastChar(char)
    setLowConf(false)
    setSessionStats(p => ({ ...p, chars: p.chars + 1 }))
    startCooldown()
  }, [startCooldown])

  // ── Send stroke to backend → get character prediction ─────
  const sendStrokeForPrediction = useCallback(async () => {
    const draw = drawCanvasRef.current
    const send = sendCanvasRef.current
    if (!draw || !send || !hasStrokeRef.current) return
    if (cooldownRef.current) return   // don't predict during gap

    // Snapshot to hidden canvas
    const ctx = send.getContext('2d')
    ctx.clearRect(0, 0, send.width, send.height)
    ctx.drawImage(draw, 0, 0)
    const dataUrl = send.toDataURL('image/png')

    setStatusLabel('Recognising...')

    try {
      const res  = await api.post('/predict', { image: dataUrl }, { withCredentials: true })
      const data = res.data.data
      if (!data) return

      const { char, confidence, low_confidence, top3: t3, error } = data

      // Blank canvas or error
      if (error === 'blank_canvas' || !char) {
        setStatusLabel('Writing')
        startCooldown()
        return
      }

      // ── Below 40% confidence → ask to redraw ──────────────
      if (confidence < REDRAW_CONF_THRESHOLD) {
        setRedrawAttempts(a => a + 1)
        setRedrawTop3(t3 || [])
        setShowRedrawPrompt(true)
        setStatusLabel('Writing')
        // Keep canvas intact so user sees what they drew
        return
      }

      // ── 40–65% confidence → accepted but flagged (existing logic) ─
      setLastChar(low_confidence ? `${char}?` : char)
      setLastConf(confidence)
      setTop3(t3 || [])
      setLowConf(!!low_confidence)
      setShowRedrawPrompt(false)
      setRedrawAttempts(0)
      setRedrawTop3([])

      if (!low_confidence) {
        wordBufferRef.current += char
        setWordSoFar(wordBufferRef.current)
        setSessionStats(p => ({ ...p, chars: p.chars + 1 }))
      }

      setStatusLabel('Writing')
      startCooldown()

    } catch (err) {
      console.error('[predict]', err)
      setErrorMsg('Backend error — is ml_service.py running?')
      setMlStatus('offline')
      setStatusLabel('Error')
      startCooldown()
    }
  }, [startCooldown])

  // ── Finish word → open save dialog ───────────────────────
  const finishWord = useCallback(() => {
    const word = wordBufferRef.current.trim()
    if (!word) return
    wordBufferRef.current = ''
    setWordSoFar('')
    setLastChar('')
    setLastConf(null)
    setTop3([])
    setLowConf(false)
    clearTimeout(letterTimerRef.current)
    clearTimeout(wordTimerRef.current)
    setPendingWord(word)
    setNoteTitle(pageTitle)
    setShowSaveDialog(true)
    setStatusLabel('Idle')
  }, [])

  // ── Fist commit → directly appends word to Recognised Text (no dialog) ──
  const commitWord = useCallback(() => {
    const word = wordBufferRef.current.trim()
    if (!word) return
    clearTimeout(letterTimerRef.current)
    clearTimeout(wordTimerRef.current)
    wordBufferRef.current = ''
    setWordSoFar('')
    setLastChar('')
    setLastConf(null)
    setTop3([])
    setLowConf(false)
    setSessionText(prev => prev ? `${prev} ${word}` : word)
    setSessionStats(p => ({ ...p, words: p.words + 1 }))
    setFistFlash(true)
    setStatusLabel('Saved ✊')
    setTimeout(() => {
      setFistFlash(false)
      setStatusLabel('Writing')
    }, 900)
  }, [])

  // ── Reset timers on finger movement ──────────────────────
  const registerMovement = useCallback(() => {
    if (cooldownRef.current) return   // ignore movement during gap
    clearTimeout(letterTimerRef.current)
    clearTimeout(wordTimerRef.current)
    setStatusLabel('Writing')
    letterTimerRef.current = setTimeout(sendStrokeForPrediction, LETTER_PAUSE_MS)
    wordTimerRef.current   = setTimeout(finishWord, WORD_PAUSE_MS)
  }, [sendStrokeForPrediction, finishWord])

  // ── Save note ─────────────────────────────────────────────
  const handleSaveNote = async () => {
    if (!noteTitle.trim()) return
    setSaving(true)
    try {
      const full = sessionText ? `${sessionText} ${pendingWord}` : pendingWord
      await api.post('/note', {
        title:          noteTitle.trim(),
        recognizedText: full,
      }, { withCredentials: true })
      setSessionText(full)
      setSessionStats(p => ({ ...p, words: p.words + 1 }))
      setSavedMsg(`"${noteTitle.trim()}" saved!`)
      setTimeout(() => setSavedMsg(''), 3000)
    } catch (err) {
      setErrorMsg('Failed to save note')
    } finally {
      setSaving(false)
      setShowSaveDialog(false)
      setNoteTitle('')
      setPendingWord('')
    }
  }

  // ── Add a space between words (thumb gesture) ────────────
  const addSpace = useCallback(() => {
    // Don't add space if canvas is empty and word buffer is also empty
    if (!wordBufferRef.current && !hasStrokeRef.current) return
    // Commit any in-progress letter first if there's a stroke on canvas
    clearTimeout(letterTimerRef.current)
    clearTimeout(wordTimerRef.current)
    // Append space to word buffer
    wordBufferRef.current += ' '
    setWordSoFar(wordBufferRef.current)
    setStatusLabel('Space ␣')
    // Flash the space indicator then clear canvas ready for next word
    setSpaceFlash(true)
    clearDrawCanvas()
    setTimeout(() => {
      setSpaceFlash(false)
      setStatusLabel('Writing')
    }, 800)
  }, [clearDrawCanvas])

  // ── Start camera + MediaPipe ──────────────────────────────
  const startSession = useCallback(() => {
    const video  = videoRef.current
    const canvas = drawCanvasRef.current
    if (!video || !canvas) return
    const ctx = canvas.getContext('2d')

    const hands = new Hands({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
    })
    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.75,
      minTrackingConfidence:  0.65,
    })

    hands.onResults(results => {
      const w = canvas.width
      const h = canvas.height

      if (!results.multiHandLandmarks?.length) {
        setHandDetected(false)
        prevPointRef.current = null

        // Start 4-second no-hand countdown only if there's a word to save
        if (wordBufferRef.current.trim() && !noHandTimerRef.current) {
          let remaining = 4000
          setNoHandSecs(4)
          noHandTimerRef.current = setInterval(() => {
            remaining -= 1000
            setNoHandSecs(Math.ceil(remaining / 1000))
            if (remaining <= 0) {
              clearInterval(noHandTimerRef.current)
              noHandTimerRef.current = null
              setNoHandSecs(0)
              finishWord()   // opens save dialog with editable title
            }
          }, 1000)
        }
        return
      }

      // Hand is back — cancel any pending no-hand save timer
      if (noHandTimerRef.current) {
        clearInterval(noHandTimerRef.current)
        noHandTimerRef.current = null
        setNoHandSecs(0)
      }
      setHandDetected(true)
      const lm = results.multiHandLandmarks[0]

      // ── Finger state helpers ──────────────────────────────
      // "Fully straight" index: walk the full chain tip→DIP→PIP→MCP
      const indexFullyStraight =
        lm[8].y < lm[7].y - 0.02 &&
        lm[7].y < lm[6].y - 0.01 &&
        lm[6].y < lm[5].y

      // Middle up: tip above PIP
      const middleUp = lm[12].y < lm[10].y
      const ringUp   = lm[16].y < lm[14].y
      const pinkyUp  = lm[20].y < lm[18].y

      // Thumb up (sideways extension): tip clearly above base knuckle, others folded
      const thumbTipY  = lm[4].y
      const thumbBaseY = lm[2].y
      const thumbUp =
        (thumbBaseY - thumbTipY) > 0.08 &&
        !indexFullyStraight && !middleUp && !ringUp && !pinkyUp

      // ── Pixel distance between index tip and middle tip ───
      // MediaPipe landmark x/y are normalised [0,1] relative to frame.
      // Multiply by canvas dimensions to get pixel distance.
      const ixPx = lm[8].x * w
      const iyPx = lm[8].y * h
      const mxPx = lm[12].x * w
      const myPx = lm[12].y * h
      const indexMiddleDist = Math.hypot(ixPx - mxPx, iyPx - myPx)

      // ✌ Erase: both index AND middle pointing up AND tips within 20px of each other
      // The proximity check ensures the fingers are pressed together ("scissor" pose),
      // not spread apart, so a normal two-finger point doesn't trigger erase.
      const isErase =
        indexFullyStraight && middleUp &&
        indexMiddleDist < 20 &&
        !ringUp && !pinkyUp

      // ✊ Fist: all fingers folded (thumb state irrelevant for fist)
      const isFist = !indexFullyStraight && !middleUp && !ringUp && !pinkyUp && !thumbUp

      // 🖐 Open hand: all fingers up — idle, lifts pen
      const isOpen = indexFullyStraight && middleUp && ringUp && pinkyUp

      // ☝ Write: only index fully straight, all others folded
      const isWrite = indexFullyStraight && !middleUp && !ringUp && !pinkyUp && !thumbUp

      // ── Gesture label badge ───────────────────────────────
      const gNow = isErase ? 'Erase ✌' : isFist ? 'Commit ✊' : isOpen ? 'Idle 🖐' : thumbUp ? 'Space 👍' : isWrite ? 'Write ☝' : 'Idle'
      setGestureLabel(gNow)

      // ── Thumb → space (latched) ───────────────────────────
      if (thumbUp && !spaceLatchedRef.current && !cooldownRef.current) {
        spaceLatchedRef.current = true
        addSpace()
      } else if (!thumbUp) {
        spaceLatchedRef.current = false
      }

      // ── Erase: index + middle joined (distance < 20px) ───
      if (isErase && !eraseLatchedRef.current && !cooldownRef.current) {
        eraseLatchedRef.current = true
        clearDrawCanvas()
        clearTimeout(letterTimerRef.current)
        clearTimeout(wordTimerRef.current)
        setEraseFlash(true)
        setStatusLabel('Erased ✌')
        setTimeout(() => {
          setEraseFlash(false)
          setStatusLabel('Writing')
        }, 600)
      } else if (!isErase) {
        eraseLatchedRef.current = false
      }

      // ── Fist → commit word directly to Recognised Text ───
      if (isFist && !fistLatchedRef.current) {
        fistLatchedRef.current = true
        commitWord()
      } else if (!isFist) {
        fistLatchedRef.current = false
      }

      // Mirror x for natural "writing toward yourself" feel
      const x = (1 - lm[8].x) * w
      const y = lm[8].y * h

      // Don't draw during cooldown gap
      if (cooldownRef.current) {
        prevPointRef.current = null
        return
      }

      // ── Write: only index fully straight and alone ────────
      if (isWrite) {
        if (prevPointRef.current) {
          const dx   = x - prevPointRef.current.x
          const dy   = y - prevPointRef.current.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist > MOVEMENT_THRESHOLD) {
            ctx.strokeStyle = 'rgb(0, 255, 255)'
            ctx.lineWidth   = 5
            ctx.lineCap     = 'round'
            ctx.lineJoin    = 'round'
            ctx.beginPath()
            ctx.moveTo(prevPointRef.current.x, prevPointRef.current.y)
            ctx.lineTo(x, y)
            ctx.stroke()
            hasStrokeRef.current = true
            registerMovement()
          }
        } else {
          registerMovement()
        }
        prevPointRef.current = { x, y }
      } else {
        // Any non-write gesture lifts the pen
        prevPointRef.current = null
      }
    })

    const camera = new Camera(video, {
      onFrame: async () => { await hands.send({ image: video }) },
      width: 640, height: 480,
    })
    camera.start()
    cameraRef.current = camera
    handsRef.current  = hands

    setIsRunning(true)
    setStatusLabel('Writing')
    setErrorMsg('')
    startTimer()
  }, [registerMovement, sendStrokeForPrediction, startTimer, addSpace, commitWord, clearDrawCanvas, finishWord])

  // ── Stop session ──────────────────────────────────────────
  const stopSession = useCallback(() => {
    cameraRef.current?.stop()
    handsRef.current?.close()
    clearTimeout(letterTimerRef.current)
    clearTimeout(wordTimerRef.current)
    if (noHandTimerRef.current) {
      clearInterval(noHandTimerRef.current)
      noHandTimerRef.current = null
    }
    setNoHandSecs(0)
    setIsRunning(false)
    setHandDetected(false)
    setStatusLabel('Idle')
    cooldownRef.current = false
    setIsCooldown(false)
    stopTimer()
  }, [stopTimer])

  // ── Cleanup on unmount ────────────────────────────────────
  useEffect(() => () => {
    cameraRef.current?.stop()
    handsRef.current?.close()
    clearTimeout(letterTimerRef.current)
    clearTimeout(wordTimerRef.current)
    if (noHandTimerRef.current) clearInterval(noHandTimerRef.current)
    stopTimer()
  }, [stopTimer])

  // ── Manual clear ──────────────────────────────────────────
  const clearAll = () => {
    clearDrawCanvas()
    wordBufferRef.current = ''
    setWordSoFar('')
    setLastChar('')
    setLastConf(null)
    setTop3([])
    setLowConf(false)
    setShowRedrawPrompt(false)
    setRedrawTop3([])
    setRedrawAttempts(0)
    clearTimeout(letterTimerRef.current)
    clearTimeout(wordTimerRef.current)
    if (noHandTimerRef.current) {
      clearInterval(noHandTimerRef.current)
      noHandTimerRef.current = null
    }
    setNoHandSecs(0)
    cooldownRef.current = false
    setIsCooldown(false)
  }

  // ── Export PDF ────────────────────────────────────────────
  const exportPDF = () => {
    const doc  = new jsPDF()
    doc.setFontSize(16)
    doc.text(pageTitle || 'Air-Writing Session Notes', 14, 18)
    doc.setFontSize(12)
    const lines = doc.splitTextToSize(sessionText || wordSoFar || 'No text yet.', 180)
    doc.text(lines, 14, 32)
    doc.save('air-writing-session.pdf')
  }

  // ── Status badge colour ───────────────────────────────────
  const statusColor = {
    'Idle':           'bg-gray-400',
    'Writing':        'bg-green-400',
    'Recognising...': 'bg-amber-400',
    'Space ␣':        'bg-purple-400',
    'Erased ✌':       'bg-red-400',
    'Saved ✊':        'bg-indigo-400',
    'Error':          'bg-red-500',
  }[statusLabel] || 'bg-gray-400'

  return (
    <div>
      {/* ── Header ── */}
      <nav className='h-16 px-4 mb-3 w-full border-b flex items-center justify-between bg-white'>
        <div className='flex flex-col text-left min-w-0'>
          {/* Inline-editable session title */}
          <input
            type="text"
            value={pageTitle}
            onChange={e => setPageTitle(e.target.value)}
            className='text-2xl font-medium bg-transparent border-b border-transparent hover:border-gray-300 focus:border-indigo-400 focus:outline-none transition-colors w-full max-w-xs truncate'
            placeholder='Note title…'
            title='Click to rename this session'
          />
          <h4 className='text-gray-500 text-xs mt-0.5'>
            ☝ Write &nbsp;·&nbsp; ✌ Join fingers = Erase &nbsp;·&nbsp; ✊ Fist = Save word &nbsp;·&nbsp; 👍 Space &nbsp;·&nbsp; 🖐 Idle
          </h4>
        </div>
        <div className='flex items-center gap-3'>
          <User onClick={() => navigate('/dashboard/settings')} size={20} className='cursor-pointer text-gray-700' />
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-4 py-4">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">

          {/* ── Canvas area ── */}
          <div className="lg:col-span-9">
            <div className="relative h-[540px] rounded-2xl bg-black shadow-md overflow-hidden">

              {/* Status */}
              <div className="absolute right-4 top-4 z-20 flex items-center gap-2 bg-white px-3 py-1.5 rounded-full shadow">
                <span className={`h-2.5 w-2.5 rounded-full ${statusColor}`} />
                <span className="text-sm font-medium text-gray-700">{statusLabel}</span>
              </div>

              {/* ML + hand + gesture badges */}
              <div className="absolute left-4 top-4 z-20 flex gap-2 flex-wrap">
                <span className={`px-2 py-1 rounded text-xs font-medium text-white
                  ${mlStatus === 'online' ? 'bg-green-600' : mlStatus === 'offline' ? 'bg-red-600' : 'bg-gray-500'}`}>
                  ML: {mlStatus}
                </span>
                {isRunning && (
                  <span className={`px-2 py-1 rounded text-xs font-medium text-white
                    ${handDetected ? 'bg-blue-600' : noHandSecs > 0 ? 'bg-orange-500' : 'bg-gray-500'}`}>
                    {handDetected ? '✋ Hand detected' : noHandSecs > 0 ? `✋ Saving in ${noHandSecs}s…` : 'No hand'}
                  </span>
                )}
                {isRunning && handDetected && gestureLabel && (
                  <span className="px-2 py-1 rounded text-xs font-medium bg-black/60 text-white border border-white/20">
                    {gestureLabel}
                  </span>
                )}
              </div>

              {/* Webcam */}
              <video ref={videoRef}
                className={`absolute inset-0 w-full h-full object-cover -scale-x-100 transition-opacity
                  ${isRunning ? 'opacity-60' : 'opacity-0'}`}
                autoPlay playsInline muted />

              {/* Stroke canvas */}
              <canvas ref={drawCanvasRef} width={640} height={480}
                className="absolute inset-0 w-full h-full"
                style={{ mixBlendMode: 'screen' }} />

              {/* Hidden send canvas */}
              <canvas ref={sendCanvasRef} width={640} height={480} className="hidden" />

              {/* Cooldown overlay */}
              {isCooldown && (
                <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                  <div className="bg-black/70 px-6 py-3 rounded-2xl text-center">
                    <p className="text-white text-sm font-medium mb-1">Letter confirmed! ✓</p>
                    <p className="text-cyan-400 text-2xl font-bold">{lastChar}</p>
                    <p className="text-gray-400 text-xs mt-1">
                      Next letter in {cooldownSecs}s…
                    </p>
                  </div>
                </div>
              )}

              {/* No-hand save countdown overlay */}
              {noHandSecs > 0 && !isCooldown && wordSoFar && (
                <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                  <div className="bg-black/75 px-8 py-5 rounded-2xl text-center">
                    <p className="text-orange-400 text-4xl font-bold mb-1">{noHandSecs}</p>
                    <p className="text-white text-sm font-semibold">Hand removed</p>
                    <p className="text-gray-300 text-xs mt-1">
                      Save dialog opens in <span className="text-orange-300 font-mono">{noHandSecs}s</span>…
                    </p>
                    <p className="text-gray-500 text-xs mt-1">Return hand to cancel</p>
                  </div>
                </div>
              )}

              {/* Space flash overlay (thumb gesture) */}
              {spaceFlash && (
                <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                  <div className="bg-black/75 px-8 py-4 rounded-2xl text-center animate-pulse">
                    <p className="text-white text-4xl font-mono tracking-widest mb-1">␣</p>
                    <p className="text-green-400 text-sm font-semibold">Space added 👍</p>
                    <p className="text-gray-400 text-xs mt-1">Start writing next word</p>
                  </div>
                </div>
              )}

              {/* Erase flash overlay (index + middle joined gesture) */}
              {eraseFlash && (
                <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                  <div className="bg-black/75 px-8 py-4 rounded-2xl text-center">
                    <p className="text-red-400 text-4xl mb-1">✌</p>
                    <p className="text-red-300 text-sm font-semibold">Stroke erased</p>
                    <p className="text-gray-400 text-xs mt-1">Draw again</p>
                  </div>
                </div>
              )}

              {/* Fist flash overlay — word committed to Recognised Text */}
              {fistFlash && (
                <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                  <div className="bg-black/80 px-10 py-5 rounded-2xl text-center">
                    <p className="text-indigo-300 text-5xl mb-2">✊</p>
                    <p className="text-white text-base font-semibold">Word saved!</p>
                    <p className="text-indigo-300 font-mono text-lg mt-1 tracking-wide">
                      {sessionText.split(' ').filter(Boolean).slice(-1)[0] || ''}
                    </p>
                    <p className="text-gray-400 text-xs mt-2">Added to Recognised Text</p>
                  </div>
                </div>
              )}

              {/* ── Redraw prompt overlay (confidence < 40%) ── */}
              {showRedrawPrompt && !isCooldown && (
                <div className="absolute inset-0 flex items-center justify-center z-20">
                  {/* Dimmed backdrop */}
                  <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

                  <div className="relative z-10 bg-gray-900 border border-amber-500/60 rounded-2xl px-6 py-5 max-w-xs w-full mx-4 shadow-2xl text-center">
                    {/* Icon + heading */}
                    <div className="flex items-center justify-center gap-2 mb-2">
                      <span className="text-amber-400 text-xl">✏️</span>
                      <p className="text-amber-400 font-semibold text-base">Low confidence</p>
                    </div>

                    <p className="text-gray-300 text-sm mb-1">
                      The model isn't sure what you drew
                      {redrawAttempts > 1 && (
                        <span className="text-gray-500"> (attempt {redrawAttempts})</span>
                      )}.
                    </p>
                    <p className="text-gray-400 text-xs mb-4">
                      Clear the canvas and draw the letter again — write larger and slower.
                    </p>

                    {/* Top-3 quick-pick */}
                    {redrawTop3.length > 0 && (
                      <div className="mb-4">
                        <p className="text-gray-500 text-xs mb-2">Or pick the closest match:</p>
                        <div className="flex justify-center gap-2">
                          {redrawTop3.map(([c, p]) => (
                            <button
                              key={c}
                              onClick={() => handlePickSuggestion(c)}
                              className="flex flex-col items-center bg-gray-800 hover:bg-amber-900/50 border border-gray-700 hover:border-amber-500 rounded-xl px-4 py-2 transition-colors"
                            >
                              <span className="text-white text-xl font-mono font-bold">{c}</span>
                              <span className="text-gray-400 text-xs mt-0.5">{(p * 100).toFixed(0)}%</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Redraw button */}
                    <button
                      onClick={handleRedraw}
                      className="w-full bg-amber-500 hover:bg-amber-400 text-black font-semibold py-2.5 rounded-xl transition-colors text-sm"
                    >
                      🔄 Clear &amp; Redraw
                    </button>

                    {/* Skip option */}
                    <button
                      onClick={() => {
                        setShowRedrawPrompt(false)
                        setRedrawTop3([])
                        setRedrawAttempts(0)
                        startCooldown()
                      }}
                      className="mt-2 text-xs text-gray-600 hover:text-gray-400 transition-colors underline"
                    >
                      Skip this letter
                    </button>
                  </div>
                </div>
              )}

              {/* Start button */}
              {!isRunning && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center">
                    <div onClick={startSession}
                      className="mx-auto h-24 w-24 rounded-full bg-blue-50 flex items-center justify-center cursor-pointer hover:bg-blue-100 transition text-4xl">
                      ▶
                    </div>
                    <p className="mt-4 text-gray-300 text-sm">
                      Click <strong className="text-white">Start</strong> to begin
                    </p>
                  </div>
                </div>
              )}

              {/* Word-so-far overlay */}
              {isRunning && !isCooldown && (wordSoFar || lastChar) && (
                <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-1">
                  <div className="bg-black/75 px-5 py-2 rounded-xl flex items-center gap-3">
                    <span className="text-white text-2xl font-mono tracking-widest">
                      {wordSoFar || '…'}
                    </span>
                    {lastChar && !isCooldown && (
                      <span className={`text-sm ${lowConf ? 'text-amber-400' : 'text-cyan-400'}`}>
                        ← {lastChar}
                        {lastConf != null && ` (${(lastConf * 100).toFixed(0)}%)`}
                        {lowConf && ' ⚠'}
                      </span>
                    )}
                  </div>
                  {/* Top-3 alternatives when confidence is low */}
                  {lowConf && top3.length > 0 && (
                    <div className="bg-black/60 px-3 py-1 rounded-lg flex gap-2 items-center">
                      <span className="text-xs text-gray-400">Did you mean:</span>
                      {top3.map(([c, p]) => (
                        <button key={c}
                          onClick={() => {
                            wordBufferRef.current += c
                            setWordSoFar(wordBufferRef.current)
                            setLowConf(false); setTop3([])
                            setSessionStats(prev => ({ ...prev, chars: prev.chars + 1 }))
                          }}
                          className="text-xs text-cyan-300 hover:text-white underline px-1">
                          {c} ({(p * 100).toFixed(0)}%)
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Saved confirmation */}
              {savedMsg && (
                <div className="absolute top-16 right-4 z-20 bg-green-600 text-white px-4 py-2 rounded-xl text-sm shadow">
                  ✓ {savedMsg}
                </div>
              )}

              {/* Error */}
              {errorMsg && (
                <div className="absolute top-16 left-4 z-20 bg-red-700 text-white px-4 py-2 rounded-xl text-sm shadow max-w-xs">
                  ✗ {errorMsg}
                  <button onClick={() => setErrorMsg('')} className="ml-2 underline text-xs">dismiss</button>
                </div>
              )}

              {/* Hint bar */}
              {isRunning && (
                <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-gray-300 text-xs px-4 py-1.5 flex gap-4 justify-center flex-wrap">
                  <span>☝️ Index straight = write</span>
                  <span>✌️ Join index+middle = erase</span>
                  <span>✊ Fist = save word</span>
                  <span>👍 Thumb = space</span>
                  <span>🖐 Open hand = idle</span>
                  <span>⏸ 1.5s pause = confirm letter</span>
                </div>
              )}
            </div>
          </div>

          {/* ── Controls sidebar ── */}
          <div className="lg:col-span-3 space-y-4">

            <div className="bg-white rounded-2xl shadow-md p-5">
              <h3 className="text-base font-semibold mb-4">Controls</h3>

              {!isRunning ? (
                <button onClick={startSession}
                  className="w-full bg-green-500 text-white py-3 rounded-xl font-semibold mb-3 hover:bg-green-600 transition">
                  ▶ Start
                </button>
              ) : (
                <button onClick={stopSession}
                  className="w-full bg-red-500 text-white py-3 rounded-xl font-semibold mb-3 hover:bg-red-600 transition">
                  ■ Stop
                </button>
              )}

              <div className="grid grid-cols-2 gap-2 mb-3">
                <button onClick={clearAll}
                  className="border rounded-xl py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                  🗑 Clear
                </button>
                <button onClick={() => wordSoFar.trim() && commitWord()}
                  disabled={!wordSoFar.trim()}
                  title="Commit current word to Recognised Text (same as ✊ fist gesture)"
                  className="border rounded-xl py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                  ✊ Commit
                </button>
              </div>

              <button onClick={exportPDF}
                className="w-full bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 transition text-sm">
                ⬇ Export PDF
              </button>
            </div>

            {/* Recognised text */}
            <div className="bg-white rounded-2xl shadow-md p-5">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-base font-semibold">Recognised Text</h3>
                {sessionText && (
                  <button
                    onClick={() => navigator.clipboard?.writeText(sessionText)}
                    className="text-xs text-gray-400 hover:text-indigo-500 transition-colors"
                    title="Copy to clipboard"
                  >
                    📋 Copy
                  </button>
                )}
              </div>
              <div className="bg-gray-50 rounded-xl p-3 text-sm text-gray-700 font-mono min-h-[56px] break-all leading-relaxed whitespace-pre-wrap">
                {sessionText
                  ? sessionText.split(' ').map((w, i, arr) => (
                      <span key={i}>
                        {/* Highlight the last committed word briefly via fistFlash */}
                        <span className={i === arr.length - 1 && fistFlash ? 'text-indigo-600 font-bold' : ''}>
                          {w}
                        </span>
                        {i < arr.length - 1 ? ' ' : ''}
                      </span>
                    ))
                  : <span className="text-gray-400">Make a ✊ fist to save words here…</span>
                }
              </div>
              {wordSoFar && !isCooldown && (
                <p className="mt-1 text-xs text-indigo-600 font-mono">
                  Building: <strong>{wordSoFar}</strong>
                  <span className="text-gray-400 ml-1">(✊ fist to commit)</span>
                </p>
              )}
            </div>

            {/* Stats */}
            <div className="bg-white rounded-2xl shadow-md p-5">
              <h3 className="text-base font-semibold mb-3">Session Stats</h3>
              {[['Characters', sessionStats.chars],
                ['Words',      sessionStats.words],
                ['Time',       sessionStats.time]].map(([l, v]) => (
                <div key={l} className="flex justify-between py-1.5 border-b last:border-0">
                  <span className="text-gray-500 text-sm">{l}</span>
                  <span className="font-semibold text-sm">{v}</span>
                </div>
              ))}
            </div>

          </div>
        </div>
      </div>

      {/* ── Save Note Dialog ── */}
      {showSaveDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-96 mx-4">
            <h2 className="text-lg font-semibold mb-1">Save Note</h2>
            <p className="text-sm text-gray-500 mb-4">
              Recognised word: <strong className="text-indigo-600 font-mono text-base">{pendingWord}</strong>
            </p>

            <label className="text-sm font-medium text-gray-700 block mb-1">Note Title</label>
            <input
              type="text"
              value={noteTitle}
              onChange={e => setNoteTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSaveNote()}
              placeholder="Give this note a title…"
              autoFocus
              className="w-full border rounded-xl px-4 py-2.5 text-sm bg-gray-50 outline-none focus:ring-2 focus:ring-indigo-300 mb-4"
            />

            <div className="flex gap-3">
              <button
                onClick={() => { setShowSaveDialog(false); setPendingWord('') }}
                className="flex-1 border rounded-xl py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">
                Discard
              </button>
              <button
                onClick={handleSaveNote}
                disabled={!noteTitle.trim() || saving}
                className="flex-1 bg-indigo-600 text-white rounded-xl py-2.5 text-sm font-semibold hover:bg-indigo-700 disabled:opacity-40">
                {saving ? 'Saving…' : 'Save Note'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
