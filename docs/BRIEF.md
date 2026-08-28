# Sounding — Project Brief

## Product

A single screen. It listens while you talk out loud and continuously surfaces the most prominent **concepts** from your ongoing monologue. The display changes constantly as you speak.

Not transcription. The point is to show you the landscape of what you're saying, so you can see it and keep talking.

---

## The name

**Sounding.** Chosen over Monologue, Clearing, Fathom, and Murmuration.

Three meanings, all correct:

- A nautical sounding drops a weighted line to measure depth — you send something out, the shape comes back.
- "Sounding out an idea" is already the thing the app is for.
- "Sounding board" is a phrase people already use for this need, so the name arrives pre-explained.

Store name likely **Sounding Board** (searchable) with **Sounding** as the spoken name and the word under the icon. Availability unchecked.

### Vocabulary

Use consistently in UI copy, type names, and comments.

| Concept | Term |
|---|---|
| A session | a **sounding** |
| Concepts on screen | **the reading** |
| Start | **drop** / **cast** |
| End | **surface** |
| Session history (future) | **the chart** |
| Extended silence | **slack** |

"The chart" is a real roadmap hint: enough soundings accumulated reveal the shape of what someone keeps circling.

### Visual direction

Nautical depth charts — sparse numerals scattered on pale blue, no borders, contours emerging from the density of readings. Concepts as marks where position and size carry meaning, not a list.

**Caution:** the name implies depth as an axis. If prominence is really about recurrence or centrality, a vertical depth axis will fight the data. Safer: a chart-plan view, readings scattered across a plane, size alone carrying weight.

---

## What kind of problem this is

Sounding is **streaming state estimation**, not a transcription pipeline with a view on top. There's a noisy incremental observation stream, and you maintain a continuously-revised estimate of "what is this person talking about," with inertia, decay, and capacity limits.

The audio and the model are I/O. **The product is the state.**

### Four layers, one of which is yours

| Layer | Job | Ownership |
|---|---|---|
| Capture | Produce frames | OS-bound, boring |
| Segmentation | Decide when enough has been said to interpret | Sets the latency floor |
| Interpretation | Segment → concept candidates | **Swappable. Will be rewritten twice.** |
| Salience | Merge candidates into the persistent reading | **This is the app** |

Interpretation must be a **port**, not a dependency: `(AudioSegment | Transcript) → ConceptCandidate[]`. The moment salience logic knows it's talking to a specific provider, a replaceable part is welded to a permanent one.

### What "salience" means here

The term is load-bearing, not shorthand. In perceptual psychology, salience is what pops out *pre-attentively* — the red dot you see before you look for it. It's a property of the relationship between a signal and its field, never of the signal alone. The same red dot in a field of red is invisible.

Two consequences:

1. **Prominence is computed against the field, not a threshold.** A concept isn't prominent because it recurred often; it's prominent relative to everything else currently on the chart. This is also why fixed capacity isn't an arbitrary constraint — an unbounded display has no field to stand out from, so nothing can be salient in it.
2. **Salience is where attention lands without deciding to.** Sounding does not show what you meant or what you concluded. It shows what your talking kept returning to whether or not you noticed. **The gap between those is the product.**

This mirrors the name: a depth sounding measures one point repeatedly, and the seabed only appears from the accumulation. No single utterance reveals what's prominent; the distribution over time does. Both words describe estimating a shape you can't observe directly by taking readings of something you can.

**Design consequence:** the algorithm must not privilege concepts that *sound like topics*. Semantic weight is not salience. A model asked to "extract key concepts" reliably returns tidy nouns rather than the thing you kept circling — someone talking through a job decision expects salary, commute, title, and what actually surfaces might be their sister, or a specific week in 2019. That is not a failure of extraction. That is the reading.

### The hard problem

**Concept identity across time.** The model says "grief" at 0:10, "mourning" at 0:25, "losing her" at 0:40. One mark or three? Get this wrong and the screen either churns meaninglessly or collapses into mush. Everything else is tractable; this determines whether the app works.

Two architectures:

- **Extract-and-merge** — model returns fresh stateless candidates; you resolve identity via embeddings + similarity threshold, then run your own decay and ranking. You own the dynamics. Stable, cheap, testable. Cost: you build the resolution machinery. **Recommended.**
- **Stateful revision** — send the current reading back and ask the model to revise it. Identity comes free and is semantically smarter. Cost: dynamics become a nondeterministic black box, prompt grows, "why did that vanish" is unanswerable.

### Two loops, not one

A single model-paced loop means the screen is dead between calls and feels broken regardless of concept quality.

- **Fast loop (10Hz+, local):** word recurrence, speech energy, pace, mid-utterance vs. slack. Drives motion and weight nudges — the sense that something is listening *right now*. Note that these are also **attention signals in their own right**, not just liveness: recurrence, emphasis, and hesitation indicate salience more reliably than semantic importance does. The fast loop should feed weight into the reading, not only animate it.
- **Slow loop (model-paced):** introduces, retires, and re-ranks actual concepts. The truth.

Users perceive responsiveness from the first and quality from the second. Decoupling them is also what lets interpretation be swapped without the app feeling different.

### Capacity is a constant, not an output

The screen holds a small fixed number of concepts. Working memory holds about four things; thirty marks is a word cloud, and word clouds are useless for thinking.

Fixed capacity changes the algorithm's job from *ranking* to *promotion and demotion under contention* — which forces explicit rules about what displaces what, and creates the app's most meaningful moment: a new concept pushing an old one off the chart is the instant you find out what you've actually been circling.

### The structural decision to make first

**Model the session as an append-only event log.** Capture emits segments, interpretation emits candidates, salience emits state transitions. All timestamped, all persisted.

The payoff is **replay**. Salience will be tuned dozens of times. Without replay each iteration costs ten minutes of talking to a device in a quiet room; with it, tuning is running a fixture against a corpus of ~20 recorded soundings in seconds.

Also gives you: tests for something otherwise untestable, "why did it do that" debugging, A/B evaluation of interpretation models on identical input, and the chart for free.

### Rate discipline

Each layer emits at its own natural rate, and **rates drop by an order of magnitude at every boundary**:

```
frames 16kHz → segments ~0.5Hz → candidates ~0.5Hz → state 10Hz → render 60Hz
```

Any boundary where a high rate leaks upward is a design error. (This generalizes the earlier "audio never crosses the bridge" rule.)

---

## Build plan

**Mac + simple web UI first. Not an iOS app.**

Mobile constraints — cellular latency, per-minute cost, small-screen capacity, battery — are properties of a delivery target, not of the problem. Tuning salience under them means never knowing which choices were the algorithm and which were the phone.

On a Mac you can be profligate: run the loop at whatever rate makes the reading good, try embeddings that would never fit on a phone, hold twelve concepts and find out empirically that four is better. Then port, and phone constraints become an optimization problem against a known-good target.

**Start with files, not live mic.** Feed it recordings, watch the reading evolve, tune. Add the microphone when the landscape already feels alive on replay.

**Insurance:** keep a rough cost and latency counter running from day one. Not to constrain the design — just so that when the reading finally feels right, you know whether you got there at 3c/min or 30c/min.

**Open question:** once it runs on a Mac with a web UI, is the iPhone actually the destination? Walks are phone-shaped, but a lot of thinking-out-loud happens at a desk at 11pm where a big screen is strictly better. Don't discard the prototype on schedule because the original plan said mobile.

### If/when it does go mobile

Native core, RN UI. Expo with a custom dev client — the Expo Modules API (`create-expo-module --local`) autolinks a local Swift module with no npm publish and no ejecting. Not Nitro; Nitro is for bare RN.

The split: native holds what the OS forces it to hold (audio session, interruptions, background). **Anything you'd change on a whim lives in TypeScript** — including the salience model, because tuning it twice in two languages is how you stop tuning it.

---

## Landscape

### Direct competitor: Overscope

Solo developer, Istanbul. Voice mind mapping for iPhone, iOS 26, in TestFlight. On-device Apple Speech, text-only backend for structure extraction. $19.99/mo or $149/yr, no free tier. Tagline: "Not a transcript, a map."

Uncomfortable overlap — same rejection of transcription, same speak-and-watch-structure-appear, same one-screen ambition. Their "what it's not" section is the positioning argument you were going to make.

Three real differences:

| | Overscope | Sounding |
|---|---|---|
| Input | Push-to-talk, hold the button | Continuous session |
| Structure | Tree (root, branches, leaves) | Flat landscape |
| Output | Editable map, PNG export | Ephemeral reading |

Push-to-talk can't survive a twenty-minute think. A tree asserts your thinking has a single root — exactly what's false when you're still figuring something out. And their map is a keepsake; your reading is a mirror.

Their existence narrows positioning usefully and proves someone thinks this is worth $149/year.

### Academic prior art — read this before designing the screen

**TalkTraces** (CHI 2019, Chandrasegaran et al.) is the closest: real-time visualization of meeting themes via topic modeling and word embeddings, iteratively evaluated, ending in design implications for real-time displays of discussion content. Essentially this spec, written seven years ago.

Two findings that should change the design:

1. **Subtle encoding failed.** Participants didn't find it distracting, but also failed to notice when they fixated on one topic or switched between topics — the chroma/luminance encoding was too subtle to perceive. Fixation and switching are exactly what Sounding exists to surface. A tasteful nautical aesthetic will encode them too quietly to register.
2. **Wrong concepts hijack.** Transcription inaccuracies drew unwanted attention. A wrong mark doesn't degrade gracefully. Use a confidence threshold below which a concept simply doesn't surface — a missing mark costs less than a wrong one.

**Word Cloud for Meeting** (ASSETS 2021): participants recognized topic changes easily but found it distracting when topics changed *in sequence*. Rapid successive churn is the failure mode → argues for fixed capacity and hysteresis in promotion.

Earlier lineage: Conversation Clusters, MeetingVis, MeetCues, Ambient Search. Mostly focused on post-meeting review because of processing and rendering constraints — constraints now gone, which is why this app is newly possible.

**The central design problem:** make the displacement moment legible enough to notice without being distracting enough to interrupt. TalkTraces failed the first; the word cloud study failed the second.

### Components — transcription is commoditized

Don't spend a week choosing. Wrap it behind the port.

**The streaming problem is solved.** Whisper-Streaming uses a LocalAgreement-n policy with self-adaptive latency (~3.3s on unsegmented long-form speech): a prefix is confirmed once n consecutive updates agree. Naive fixed-window chunking splits words mid-utterance. The commit/pending distinction maps cleanly onto the two loops — pending feeds fast, committed feeds slow.

| Option | Note |
|---|---|
| **Groq Whisper Large v3 Turbo** | ~$0.04/hr, ~9x cheaper than OpenAI hosted. **Use for the prototype.** |
| ElevenLabs Scribe v2 Realtime | 150ms latency (Mar 2026) |
| Deepgram Nova-3 / Flux | <300ms streaming; Flux folds end-of-turn detection into the model, avoiding 200–600ms of external VAD. ~$0.46/hr streaming |
| AssemblyAI Universal-3.5 Pro Realtime | ~$0.45/hr |
| Voxtral (Mistral, Feb 2026) | 4B streaming, Apache 2.0; whisper.cpp still safer on modest hardware |
| Parakeet TDT / Moonshine | Streaming-native / smallest edge footprint |

At four cents an hour, long sessions stop being a business-model problem.

---

## Unresolved

- **Audio-native probably beats transcribe-then-extract.** One hop instead of two, and it hears emphasis and hesitation. Given that prosody is a better attention signal than semantic weight (see *What "salience" means here*), the signals text discards are precisely the ones this app runs on. Transcription flattens the seabed before you measure it. Rank this above the interpretation-provider choice — it's an architecture question, not a vendor one.
- **Storage:** persist transcripts and concepts encrypted; never persist raw audio. There's no reason to keep it once the reading is back.
- **Keys need a backend proxy** the moment there's a shipped client.
- **Multi-source interpretation (v2):** several model calls with different jobs — entities, emotional register, *what you're circling but not naming* — with salience merging disagreeing sources. The third one is the interesting one.
- **Second person, asynchronously:** two people do *separate* soundings on the same question, then compare charts. Novel artifact, no diarization, no shared session. A feature of the chart, not the sounding. A live shared session, by contrast, turns this into a meeting tool — the crowded, repeatedly-disappointing space the research above lives in.

## The real competitor

Not Overscope. **A chat window.** The argument for Sounding is that talking is faster than typing, and a landscape you can glance at beats prose you have to read. That's a strong argument — but make it explicit, because it's the comparison a user will actually make.
