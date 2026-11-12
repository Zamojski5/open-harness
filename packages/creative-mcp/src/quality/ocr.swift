import Foundation
import Vision
import ImageIO
var out: [[String: Any]] = []
for path in CommandLine.arguments.dropFirst() {
  var items: [[String: Any]] = []
  if let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    let h = VNImageRequestHandler(cgImage: img, options: [:])
    try? h.perform([req])
    for o in (req.results ?? []) {
      guard let c = o.topCandidates(1).first else { continue }
      let b = o.boundingBox
      items.append(["text": c.string, "confidence": Double(c.confidence), "x": Double(b.minX), "y": Double(1 - b.maxY), "width": Double(b.width), "height": Double(b.height)])
    }
  }
  out.append(["file": path, "items": items])
}
let d = try! JSONSerialization.data(withJSONObject: out)
FileHandle.standardOutput.write(d)
