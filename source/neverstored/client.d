module neverstored.client;

import neverstored.proto;

import core.time : seconds;
import std.json : JSONValue;
import std.socket : AddressFamily, Socket, SocketOption, SocketOptionLevel, SocketType, UnixAddress;

/// Well under serverino's per-request budget, so a broker that goes quiet costs one failed
/// request instead of a worker killed mid-flight.
private enum brokerTimeout = 2.seconds;

private Socket connection;
private string socketPath;

void useBroker(string path)
{
   socketPath = path;
}

/// One persistent connection per worker. A failure on the way out is retried, because
/// nothing can have been applied yet; a failure on the way back never is. Retrying a reply
/// we did not hear would re-apply a delivery the broker had already accepted, and the page
/// would report a failure on a secret that did arrive.
JSONValue ask(JSONValue request)
{
   foreach (attempt; 0 .. 2)
   {
      if (connection is null && !connect()) break;

      if (!sendFrame(connection, request))
      {
         disconnect();
         continue;
      }

      JSONValue reply;
      if (receiveFrame(connection, reply)) return reply;

      disconnect();
      break;
   }

   return failure("unavailable");
}

private bool connect()
{
   try
   {
      connection = new Socket(AddressFamily.UNIX, SocketType.STREAM);
      connection.setOption(SocketOptionLevel.SOCKET, SocketOption.RCVTIMEO, brokerTimeout);
      connection.setOption(SocketOptionLevel.SOCKET, SocketOption.SNDTIMEO, brokerTimeout);
      connection.connect(new UnixAddress(socketPath));
      return true;
   }
   catch (Exception)
   {
      connection = null;
      return false;
   }
}

private void disconnect()
{
   if (connection is null) return;

   try connection.close();
   catch (Exception) {}

   connection = null;
}
