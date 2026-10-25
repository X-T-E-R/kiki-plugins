import json
import os
import socket
import sys
from pathlib import Path
from bili_cli.main import main
from bili_cli.commands import video

# The video metadata and stream selection are account/HTTP fixtures. FFmpeg and
# the donor's frame extraction, planning, image files and contact sheet are real.
original_connect = socket.socket.connect
def local_connect(self, address):
    if not isinstance(address, tuple) or address[0] not in ('127.0.0.1', '::1'):
        raise AssertionError('Unexpected Python network access')
    return original_connect(self, address)
socket.socket.connect = local_connect
class FixtureVideo:
    async def get_info(self):
        return {'bvid': 'BV1Q541167Qg', 'pages': [{'page': 1, 'cid': 123, 'duration': 2}]}
    async def get_download_url(self, **kwargs):
        return {'dash': {'video': [{'baseUrl': os.environ['BILI_FIXTURE_STREAM'], 'height': 180, 'codecs': 'avc1'}]}}
video._video = lambda value: FixtureVideo()
sys.argv = ['bili', *sys.argv[1:]]
main()
