/**
 * Minimal ambient types for the untyped `ali-oss` package.
 * Only the surface used by `upload.ts` is declared.
 */
declare module "ali-oss" {
  interface AliOssClientOptions {
    region?: string
    accessKeyId?: string
    accessKeySecret?: string
    stsToken?: string
    bucket?: string
    endpoint?: string
    secure?: boolean
  }
  interface AliOssPutOptions {
    contentLength?: number
    headers?: Record<string, string>
  }
  interface AliOssMultipartOptions extends AliOssPutOptions {
    partSize?: number
  }
  class OSS {
    constructor(options?: AliOssClientOptions)
    putStream(name: string, stream: unknown, options?: AliOssPutOptions): Promise<unknown>
    multipartUpload(name: string, file: unknown, options?: AliOssMultipartOptions): Promise<unknown>
  }
  export default OSS
}
