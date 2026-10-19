# Automatic probe input sources

These small, fixed inputs are source assets, not user uploads, training data,
model weights, inferred output, or evidence that a consumer passed a probe.
Only signed private COS downloads are used in real challenges.

## nasa-pose-source.jpg and pose-16frames.mp4

Source: NASA image **iss067e147098**, June 21, 2022. Credit: NASA.
https://www.nasa.gov/image-article/astronaut-samantha-cristoforetti-exercises-practices-yoga-maneuvers/
Downloaded rendition:
https://www.nasa.gov/wp-content/uploads/2023/03/iss067e147098.jpg?w=1024

Use basis: NASA Images and Media Usage Guidelines, checked October 19, 2026:
https://www.nasa.gov/nasa-brand-center/images-and-media/
The source page identifies no separate third-party copyright holder. The image
is used only as a small factual software-validation input, with source credit;
it is not used as advertising, endorsement, a NASA logo, face identification,
or model-training material. NASA/ESA do not endorse Gulong or its services.

The JPEG is unchanged. The MP4 is a **declared derived technical fixture**:
the still is letterboxed to 512x512 and repeated at 8 FPS for two seconds
(16 frames), with no audio. Its preparation uses the pinned installed FFmpeg
binary and `scripts/prepare-probe-fixtures.ps1`. It can test complete-frame
processing and object/pose detection, not motion-quality or moving-object
tracking accuracy. Receipts must not claim those untested capabilities.

JPEG SHA-256: `bf68496dd810ed43df4ef8a68008b22fada9800b56eb90e6bf7cc8d15c39ae7d`
MP4 SHA-256: `3a2af643f2723ed16b0240a8d4e416b256d499320f143233a50ad89a6dfcd293`

## jfk.flac

Unchanged official Whisper test input from the pinned OpenAI Whisper revision
`86098128c0b4f24f0e2aa2994de830614b474227`:
https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/tests/jfk.flac
The official accompanying transcribe test establishes the English phrases and
complete segment semantics. Duration: 11 seconds, 44.1 kHz stereo.
SHA-256: `63a4b1e4c1dc655ac70961ffbf518acd249df237e5a0152faae9a4a836949715`

Whisper repository license follows. Keep this notice with redistributed inputs.

MIT License

Copyright (c) 2022 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
