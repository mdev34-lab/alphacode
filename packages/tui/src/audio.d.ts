declare module "*.mp3" {
  const path: string
  export default path
}

declare module "./assets/audio/*.mp3" {
  const path: string
  export default path
}
