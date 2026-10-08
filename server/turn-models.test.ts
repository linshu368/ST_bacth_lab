import {test} from 'node:test';
import assert from 'node:assert/strict';
import {attachTurnModels,turnModelIndex} from './turn-models.js';
import {excludeLastTurn} from '../src/lib/replay-sample.js';

test('models match the actual turn and survive exclusion of the last turn',()=>{
  const identity={session_id:'session',user_id:'user',character_id:'character'};
  const rows=[{...identity,id:'first',turn_index:21,user_input:'one',assistant_reply:'reply',model:'model/a'},
    {...identity,id:'last',turn_index:22,user_input:'two',assistant_reply:null,model:'model/b'}];
  const sample:any={source_session_id:'session',source_user_id:'user',source_character_id:'character',source_history_id:'last',turn_index:22,
    history:[{role:'system',content:'system'},{role:'user',content:'one'},{role:'assistant',content:'reply'},{role:'user',content:'two'}],user_input:'two',original_assistant_reply:null,original_model:'model/b'};
  const mapped=attachTurnModels(sample,turnModelIndex(rows));
  assert.deepEqual(mapped.turn_models?.map(t=>t.model),['model/a','model/b']);
  const replay=excludeLastTurn(mapped);
  assert.equal(replay.original_model,'model/a');assert.equal(replay.turn_index,21);
  assert.equal(replay.turn_models?.length,1);assert.equal(mapped.turn_models?.length,2);
  assert.throws(()=>attachTurnModels(sample,turnModelIndex(rows.slice(1))),/缺少唯一/);
  assert.throws(()=>attachTurnModels(sample,turnModelIndex([...rows,{...rows[0],id:'ambiguous',model:'model/c'}])),/缺少唯一/);
});
