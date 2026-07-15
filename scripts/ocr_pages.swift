import AppKit
import Foundation
import Vision

struct OCRLine: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let glyphs: [OCRGlyph]
}

struct OCRGlyph: Codable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct OCRPage: Codable {
    let image: String
    let width: Int
    let height: Int
    let lines: [OCRLine]
}

func repairMissingGlyphBoxes(_ source: [OCRGlyph]) -> [OCRGlyph] {
    var glyphs = source
    var index = 0

    while index < glyphs.count {
        if glyphs[index].width > 0.0001 && glyphs[index].height > 0.0001 {
            index += 1
            continue
        }

        let runStart = index
        while index < glyphs.count && (glyphs[index].width <= 0.0001 || glyphs[index].height <= 0.0001) {
            index += 1
        }
        let runEnd = index
        let previous = runStart > 0 ? glyphs[runStart - 1] : nil
        let next = runEnd < glyphs.count ? glyphs[runEnd] : nil
        let runCount = runEnd - runStart

        let neighborWidths = [previous?.width, next?.width].compactMap { $0 }.filter { $0 > 0.0001 }
        let averageWidth = neighborWidths.isEmpty ? 0.007 : neighborWidths.reduce(0, +) / Double(neighborWidths.count)
        let previousEnd = previous.map { $0.x + $0.width }
        let availableGap = (previousEnd != nil && next != nil) ? max(0, next!.x - previousEnd!) : 0
        let glyphWidth = availableGap > 0.001 ? availableGap / Double(runCount) : averageWidth
        let startX = previousEnd ?? max(0, (next?.x ?? 0) - glyphWidth * Double(runCount))
        let glyphY = previous?.y ?? next?.y ?? 0
        let glyphHeight = max(max(previous?.height ?? 0, next?.height ?? 0), 0.006)

        for offset in 0..<runCount {
            let original = glyphs[runStart + offset]
            glyphs[runStart + offset] = OCRGlyph(
                text: original.text,
                x: startX + Double(offset) * glyphWidth,
                y: glyphY,
                width: glyphWidth,
                height: glyphHeight
            )
        }
    }

    return glyphs
}

func recognize(_ path: String) throws -> OCRPage {
    guard let image = NSImage(contentsOfFile: path),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        throw NSError(domain: "OCR", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not open image: \(path)"])
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    request.minimumTextHeight = 0.004

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])

    let observations = (request.results ?? []).sorted { left, right in
        let verticalDelta = abs(left.boundingBox.midY - right.boundingBox.midY)
        if verticalDelta > 0.006 {
            return left.boundingBox.midY > right.boundingBox.midY
        }
        return left.boundingBox.minX < right.boundingBox.minX
    }

    let lines = observations.compactMap { observation -> OCRLine? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        let rawGlyphs = candidate.string.indices.compactMap { start -> OCRGlyph? in
            let end = candidate.string.index(after: start)
            guard let characterBox = try? candidate.boundingBox(for: start..<end) else { return nil }
            let characterRect = characterBox.boundingBox
            return OCRGlyph(
                text: String(candidate.string[start..<end]),
                x: characterRect.minX,
                y: 1.0 - characterRect.maxY,
                width: characterRect.width,
                height: characterRect.height
            )
        }
        let glyphs = repairMissingGlyphBoxes(rawGlyphs)
        return OCRLine(
            text: candidate.string,
            confidence: candidate.confidence,
            x: box.minX,
            y: 1.0 - box.maxY,
            width: box.width,
            height: box.height,
            glyphs: glyphs
        )
    }

    return OCRPage(
        image: URL(fileURLWithPath: path).lastPathComponent,
        width: cgImage.width,
        height: cgImage.height,
        lines: lines
    )
}

guard CommandLine.arguments.count >= 3 else {
    fputs("Usage: ocr_pages output.json image...\n       ocr_pages --directory output-dir image...\n", stderr)
    exit(2)
}

let directoryMode = CommandLine.arguments[1] == "--directory"
let outputPath: String
let imagePaths: [String]

if directoryMode {
    guard CommandLine.arguments.count >= 4 else {
        fputs("Usage: ocr_pages --directory output-dir image...\n", stderr)
        exit(2)
    }
    outputPath = CommandLine.arguments[2]
    imagePaths = Array(CommandLine.arguments.dropFirst(3))
} else {
    outputPath = CommandLine.arguments[1]
    imagePaths = Array(CommandLine.arguments.dropFirst(2))
}

do {
    let encoder = JSONEncoder()
    encoder.outputFormatting = directoryMode
        ? [.sortedKeys, .withoutEscapingSlashes]
        : [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]

    if directoryMode {
        let outputDirectory = URL(fileURLWithPath: outputPath, isDirectory: true)
        try FileManager.default.createDirectory(
            at: outputDirectory,
            withIntermediateDirectories: true
        )

        for (index, imagePath) in imagePaths.enumerated() {
            let imageName = URL(fileURLWithPath: imagePath).deletingPathExtension().lastPathComponent
            let destination = outputDirectory.appendingPathComponent("\(imageName).json")
            if FileManager.default.fileExists(atPath: destination.path) {
                print("[\(index + 1)/\(imagePaths.count)] \(imageName): already recognized")
                continue
            }

            let page = try autoreleasepool { try recognize(imagePath) }
            let data = try encoder.encode(page)
            try data.write(to: destination, options: .atomic)
            print("[\(index + 1)/\(imagePaths.count)] \(imageName): recognized")
        }
        print("OCR directory complete: \(outputPath)")
    } else {
        let pages = try imagePaths.map(recognize)
        let data = try encoder.encode(pages)
        try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
        print("Wrote \(pages.count) page(s) to \(outputPath)")
    }
} catch {
    let nsError = error as NSError
    fputs(
        "OCR failed: \(error) [\(nsError.domain) \(nsError.code)] \(nsError.userInfo)\n",
        stderr
    )
    exit(1)
}
