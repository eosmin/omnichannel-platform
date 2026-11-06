// What each channel takes in a file. Read by the server, the worker and the plugins only: the browser must not
// import this module (its tables would ship in every bundle; a spec of the web enforces it).
export * from './channel-media-rules'
export * from './meta-media-rules'
export * from './whatsapp-media'
