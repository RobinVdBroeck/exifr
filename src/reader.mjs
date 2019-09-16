import {findTiff} from './parser.mjs'
import {hasBuffer, isBrowser, isNode} from './buff-util.mjs'
import {processOptions} from './options.mjs'
// Sigh... Ugly, ugly, ugly. FS Promises are experimental plus this code needs to be isomorphic
// and work without fs altogether.
import _fs from 'fs'
var fs = typeof _fs !== 'undefined' ? _fs.promises : undefined


// TODO: - minified UMD bundle
// TODO: - offer two UMD bundles (with tags.mjs dictionary and without)
// TODO: - API for including 3rd party XML parser
// TODO: - better code & file structure


export default class Reader {

	constructor(options) {
		this.options = processOptions(options)
	}

	async read(arg) {
		if (typeof arg === 'string')
			return this.readString(arg)
		else if (isBrowser && arg instanceof HTMLImageElement)
			return this.readString(arg.src)
		else if (hasBuffer && Buffer.isBuffer(arg))
			return this.readBuffer(arg)
		else if (arg instanceof Uint8Array)
			return this.readUint8Array(arg)
		else if (arg instanceof ArrayBuffer)
			return this.readArrayBuffer(arg)
		else if (arg instanceof DataView)
			return this.readBuffer(arg)
		else if (isBrowser && arg instanceof Blob)
			return this.readBlob(arg)
		else
			throw new Error(`Invalid input argument: ${arg} (${typeof arg})`)
	}

	readString(string) {
		if (isBase64Url(string))
			return this.readBase64(string)
		else if (isBrowser)
			return this.readUrl(string)
		else if (isNode)
			return this.readFileFromDisk(string)
		else
			throw new Error(`Invalid string input argument: ${string} (isBrowser: ${isBrowser}, isNode: ${isNode})`)
	}

	readUint8Array(uint8arr) {
		return this.readArrayBuffer(uint8arr.buffer)
	}

	readArrayBuffer(arrayBuffer) {
		return this.readBuffer(new DataView(arrayBuffer))
	}

	readBuffer(buffer) {
		let tiffPosition = findTiff(buffer)
		if (tiffPosition === undefined) return
		return [buffer, tiffPosition]
	}

	async readBlob(blob) {
		this.reader = new BlobReader(blob, this.options)
		return this.reader.read(this.options.parseChunkSize)
	}

	async readUrl(url) {
		this.reader = new UrlReader(url, this.options)
		return this.reader.read(this.options.parseChunkSize)
	}

	async readBase64(base64) {
		this.reader = new Base64Reader(base64, this.options)
		return this.reader.read(this.options.seekChunkSize)
	}

	async readFileFromDisk(filePath) {
		this.reader = new FsReader(filePath, this.options)
		return this.reader.read()
	}

	get mode() {
		return this.reader ? 'chunked' : 'whole'
	}

}



// This method came through three iterations. Tested with 4MB file with EXIF at the beginning.
// iteration #1 - Fetch whole file.
//              - Took about 23ms on average.
//              - It meant unnecessary conversion of whole 4MB
// iteration #2 - Fetch first 512 bytes, find exif, then fetch additional kilobytes of exif to be parsed.
//              - Exactly like what we do with Node's readFile() method.
//              - Slightly faster. 18ms on average.
//              - Certainly more efficient processing-wise. Only beginning of the file was read and converted.
//              - But the additional read of the exif chunk is expensive time-wise because browser's fetch and
//              - Blob<->ArrayBuffer manipulations are not as fast as Node's low-level fs.open() & fs.read().
// iteration #3 - This one we landed on.
//              - 11ms on average. (As fast as Node)
//              - Compromise between time and processing costs.
//              - Fetches first 64KB of the file. In most cases, EXIF isn't larger than that.
//              - In most cases, the 64KB is enough and we don't need additional fetch/convert operation.
//              - But we can do the second read if needed (edge cases) where the performance wouldn't be great anyway.
// It can be used with Blobs, URLs, Base64 (URL).
// blobs and fetching from url uses larger chunks with higher chances of having the whole exif within (iteration 3).
// base64 string (and base64 based url) uses smaller chunk at first (iteration 2).

// Accepts file path and uses lower-level FS APIs to open the file, read the first 512 bytes
// trying to locate EXIF and then reading only the portion of the file where EXIF is if found.
// If the EXIF is not found within the first 512 Bytes. the range can be adjusted by user,
// or it falls back to reading the whole file if enabled with options.allowWholeFile.

class ChunkedReader {
	
	constructor(input, options) {
		this.input = input
		this.options = options
	}

	async read(size) {
		// Reading additional segments (XMP, ICC, IPTC) requires whole file to be loaded.
		// Chunked reading is only available for simple exif (APP1) FTD0
		if (this.forceWholeFile) return this.readWhole()
		// Read Chunk
		let view = await this.readChunked(size)
		if (view) return view
		// Seeking for the exif at the beginning of the file failed.
		// Fall back to scanning throughout the whole file if allowed.
		if (this.allowWholeFile) return this.readWhole()
	}

	get allowWholeFile() {
		if (this.options.wholeFile === false) return false
		return this.options.wholeFile === true
			|| this.options.wholeFile === undefined
	}

	get forceWholeFile() {
		if (this.allowWholeFile === false) return false
		return this.options.wholeFile === true
			|| this.needWholeFile
	}

	get needWholeFile() {
		return !!this.options.xmp
			|| !!this.options.icc
			|| !!this.options.iptc
	}

	destroy() {}

}



class FsReader extends ChunkedReader {

	async readWhole() {
		let buffer = await fs.readFile(this.input)
		let tiffPosition = findTiff(buffer)
		return [buffer, tiffPosition]
	}

	async readChunk({start, size}) {
		let chunk = Buffer.allocUnsafe(size)
		await this.fh.read(chunk, 0, size, start)
		return chunk
	}

	async readChunked() {
		this.fh = await fs.open(this.input, 'r')
		try {
			var seekChunk = Buffer.allocUnsafe(this.options.seekChunkSize)
			var {bytesRead} = await this.fh.read(seekChunk, 0, seekChunk.length, null)
			if (!bytesRead) return this.destroy()
			// Try to search for beginning of exif within the first 512 bytes.
			var tiffPosition = findTiff(seekChunk)
			if (tiffPosition && tiffPosition.start && tiffPosition.size) {
				// Exif was found. Allocate appropriately sized buffer and read the whole exif into the buffer.
				// NOTE: does not load the whole file, just exif.
				var tiffChunk = await this.readChunk(tiffPosition)
				//await this.destroy()
				return [tiffChunk, {start: 0}]
			}
			// Close FD/FileHandle since we're using lower-level APIs.
			//await this.destroy()
		} catch(err) {
			// Try to close the FD/FileHandle in any case.
			//await this.destroy()
			throw err
		}
	}

	// TODO: auto close file handle when reading and parsing is over
	// (app can read more chunks after parsing the first)
	async destroy() {
		if (this.fh) {
			await this.fh.close().catch(console.error)
			this.fh = undefined
		}
	}

}



class WebReader extends ChunkedReader {

	async readWhole() {
		let view = await this.readChunk()
		let tiffPosition = findTiff(view)
		return [view, tiffPosition]
	}

	async readChunked(size) {
		let start = 0
		let end = size
		let view = await this.readChunk({start, end, size})
		let tiffPosition = findTiff(view)
		if (tiffPosition !== undefined) {
			// Exif was found.
			if (tiffPosition.end > view.byteLength) {
				// Exif was found outside the buffer we alread have.
				// We need to do additional fetch to get the whole exif at the location we found from the first chunk.
				view = await this.readChunk(tiffPosition)
				return [view, {start: 0}]
			} else {
				return [view, tiffPosition]
			}
		}
	}

}


function sanitizePosition(position = {}) {
	let {start, size, end} = position
	if (start === undefined) return {start: 0}
	if (size !== undefined)
		end = start + size
	else if (end !== undefined)
		size = end - start
	return {start, size, end}

}

class Base64Reader extends WebReader {

	// Accepts base64 or base64 URL and converts it to DataView and trims if needed.
	readChunk(position) {
		let {start, end} = sanitizePosition(position)
		// Remove the mime type and base64 marker at the beginning so that we're left off with clear b64 string.
		let base64 = this.input.replace(/^data\:([^\;]+)\;base64,/gmi, '')
		if (hasBuffer) {
			// TODO: Investigate. this might not work if bundled Buffer is used in browser.
			// the slice/subarray shared memory viewed through DataView problem
			var arrayBuffer = Buffer
				.from(base64, 'base64')
				.slice(start, end)
				.buffer
		} else {
			var offset = 0
			// NOTE: Each 4 character block of base64 string represents 3 bytes of data.
			if (start !== undefined || end !== undefined) {
				if (start === undefined) {
					var blockStart = start = 0
				} else {
					var blockStart = Math.floor(start / 3) * 4
					offset = start - ((blockStart / 4) * 3)
				}
				if (end === undefined) {
					var blockEnd = base64.length
					end = (blockEnd / 4) * 3
				} else {
					var blockEnd = Math.ceil(end / 3) * 4
				}
				base64 = base64.slice(blockStart, blockEnd)
				var targetSize = end - start
			} else {
				var targetSize = (base64.length / 4) * 3
			}
			var binary = atob(base64)
			var arrayBuffer = new ArrayBuffer(targetSize)
			var uint8arr = new Uint8Array(arrayBuffer)
			for (var i = 0; i < targetSize; i++)
				uint8arr[i] = binary.charCodeAt(offset + i)
		}
		return new DataView(arrayBuffer)
	}

}

class UrlReader extends WebReader {

	async readChunk(position) {
		let {start, end} = sanitizePosition(position)
		let url = this.input
		let headers = {}
		if (start || end) headers.range = `bytes=${[start, end].join('-')}`
		let res = await fetch(url, {headers})
		let chunk = new DataView(await res.arrayBuffer())
		return chunk
	}

}

class BlobReader extends WebReader {

	readChunk(position) {
		let {start, end} = sanitizePosition(position)
		let blob = this.input
		if (end) blob = blob.slice(start, end)
		return new Promise((resolve, reject) => {
			let reader = new FileReader()
			reader.onloadend = () => resolve(new DataView(reader.result || new ArrayBuffer(0)))
			reader.onerror = reject
			reader.readAsArrayBuffer(blob)
		})
	}

}


// HELPER FUNCTIONS

function isBase64Url(string) {
	return string.startsWith('data:')
		|| string.length > 10000 // naive
	//	|| string.startsWith('/9j/') // expects JPG to always start the same
}

