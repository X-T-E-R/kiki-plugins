import asyncio
import json
import socket
from bili_cli import config, output
from bili_cli.commands import feed, dm, comment


def deny(*args, **kwargs):
    raise AssertionError('Unexpected network access')


loop = asyncio.new_event_loop()
socket.create_connection = deny
socket.socket.connect = deny
config.require_credential = lambda: object()
output.settings.raw = False
counts = {'replies': 2, 'mentions': 1, 'likes': 0, 'system': 0, 'private_messages': 1, 'up_assistant': 0}
reads = []


async def unread(cred):
    return dict(counts)


async def replies(cred, cursor, limit):
    reads.append(['replies', cursor, limit])
    return {'items': [{'id': 1, 'content': 'reply', 'rpid': 11, 'root': 10, 'on': {'type': 'video', 'bvid': 'BV1Q541167Qg'}}]}


async def mentions(cred, cursor, limit):
    reads.append(['mentions', cursor, limit])
    return {'items': [{'id': 2, 'content': '@name'}]}


async def conversations(cred, limit):
    reads.append(['private_messages', limit])
    return [{'talker_id': 123, 'unread_count': 1}]


feed._unread = unread
feed._replies = replies
feed._mentions = mentions
dm.unread_conversations = conversations
results = []
feed.run = lambda body: results.append(loop.run_until_complete(body()))
feed.notifications()
assert results[0] == {'unread': counts, 'total': 4}
assert reads == []
feed.inbox(limit=5)
assert reads == [['replies', None, 2], ['mentions', None, 1], ['private_messages', 5]]
assert results[1]['replies'][0]['rpid'] == 11
assert results[1]['private_messages'][0]['unread_count'] == 1
assert comment.CHECK_PAGES == 3
assert comment._check_result(11, [], set())['found'] is False
loop.close()
print(json.dumps({'notifications': results[0], 'inbox': results[1], 'reads': reads}))
