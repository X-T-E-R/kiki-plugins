import json
import socket
import sys
from importlib.metadata import version
from typer.main import get_command
from bili_cli.main import app
from bili_cli.commands import auth, comment, dm, hot, search, upload, video, asr, feed

assert version('bili-agent') == '1.0.0'
def deny(*args, **kwargs):
    raise AssertionError('Unexpected network access')
socket.create_connection = deny
socket.socket.connect = deny
seen = []
for module in (auth, comment, dm, hot, search, upload, video, asr, feed):
    module.run = lambda body: seen.append(True)
for args in json.load(sys.stdin):
    before = len(seen)
    get_command(app).main(args=['--compact', *args], standalone_mode=False)
    assert len(seen) == before + 1, args
print(json.dumps({'accepted': len(seen)}))
