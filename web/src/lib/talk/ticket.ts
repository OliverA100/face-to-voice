/** A ticket into a live conversation, as the token route gives it (lib/server/talk.ts). Types only. */
export interface TalkTicket {
  serverUrl: string;
  token: string;
  room: string;
  name: string; // the character's name
  maxSeconds: number;
}
