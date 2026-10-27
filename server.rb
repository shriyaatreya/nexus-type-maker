# Tiny static server for local development. Sends no-cache headers so the
# browser always picks up edited files. Uses only Ruby's standard library.
require 'webrick'

port = (ENV['PORT'] || 5173).to_i
server = WEBrick::HTTPServer.new(
  Port: port,
  DocumentRoot: __dir__,
  AccessLog: [],
  MimeTypes: WEBrick::HTTPUtils::DefaultMimeTypes.merge('js' => 'text/javascript'),
  RequestCallback: ->(_req, res) { res['Cache-Control'] = 'no-store' },
)
trap('INT') { server.shutdown }
puts "Nexus Type running at http://localhost:#{port}"
server.start
